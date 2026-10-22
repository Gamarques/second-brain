import "../env.js";

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { Pool, PoolClient } from "pg";

import { reportStartupFailure } from "../env.js";
import { createDatabasePool } from "./client.js";
import { requireDatabaseConfiguration } from "./config.js";
import { toDatabaseStartupError } from "./failure.js";

const migrationSchema = "drizzle";
const migrationTable = "__drizzle_migrations";
const migrationLockName = "second-brain:drizzle-migrations:v1";

export function migrationsFolder(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

function assertMigrationSequence(
  migrations: readonly MigrationMeta[],
  applied: readonly { hash: string; createdAt: string }[],
): void {
  const seenTimestamps = new Set<number>();
  for (const migration of migrations) {
    if (seenTimestamps.has(migration.folderMillis)) {
      throw new Error(
        `Migration journal contains duplicate timestamp ${migration.folderMillis}.`,
      );
    }
    seenTimestamps.add(migration.folderMillis);
  }

  if (applied.length > migrations.length) {
    throw new Error("The database contains migrations unknown to this build.");
  }

  for (const [index, record] of applied.entries()) {
    const expected = migrations[index];
    if (expected === undefined) {
      throw new Error("The database migration ledger has an unexpected gap.");
    }
    if (record.createdAt !== String(expected.folderMillis)) {
      throw new Error(
        `Migration order mismatch at ledger position ${index + 1}.`,
      );
    }
    if (record.hash !== expected.hash) {
      throw new Error(
        `Migration checksum mismatch for timestamp ${record.createdAt}.`,
      );
    }
  }
}

async function prepareLedger(client: PoolClient): Promise<void> {
  await client.query(`create schema if not exists "${migrationSchema}"`);
  await client.query(
    `create table if not exists "${migrationSchema}"."${migrationTable}" (
      id serial primary key,
      hash text not null,
      created_at bigint not null unique
    )`,
  );
}

async function ledgerExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ ledger: string | null }>(
    "select to_regclass($1) as ledger",
    [`${migrationSchema}.${migrationTable}`],
  );
  return (
    result.rows[0]?.ledger !== null && result.rows[0]?.ledger !== undefined
  );
}

async function assertFreshDatabaseWhenUnmanaged(
  client: PoolClient,
): Promise<void> {
  if (await ledgerExists(client)) return;
  const result = await client.query<{ object_name: string }>(
    `select object_name from (
       select c.relname as object_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
         and not exists (
           select 1 from pg_depend d
           where d.classid = 'pg_class'::regclass
             and d.objid = c.oid
             and d.deptype = 'e'
         )
       union all
       select t.typname as object_name
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
         and t.typtype in ('d', 'e')
         and t.typelem = 0
         and not exists (
           select 1 from pg_depend d
           where d.classid = 'pg_type'::regclass
             and d.objid = t.oid
             and d.deptype = 'e'
         )
     ) objects order by object_name limit 1`,
  );
  const legacyObject = result.rows[0]?.object_name;
  if (legacyObject !== undefined) {
    throw new Error(
      `Clean v1 migrations require an empty database; found public object ${legacyObject}.`,
    );
  }
}

async function readAppliedMigrations(
  client: PoolClient,
): Promise<readonly { hash: string; createdAt: string }[]> {
  const result = await client.query<{ hash: string; created_at: string }>(
    `select hash, created_at from "${migrationSchema}"."${migrationTable}" order by created_at`,
  );
  return result.rows.map((row) => ({
    hash: row.hash,
    createdAt: String(row.created_at),
  }));
}

async function applyMigration(
  client: PoolClient,
  migration: MigrationMeta,
): Promise<void> {
  await client.query("begin");
  try {
    // Simple-query protocol executes the complete migration atomically in one
    // round trip while retaining the explicit transaction and rollback below.
    const statements = migration.sql
      .filter((statement) => statement.trim() !== "")
      .join(";\n");
    if (statements !== "") await client.query(statements);
    await client.query(
      `insert into "${migrationSchema}"."${migrationTable}" (hash, created_at) values ($1, $2)`,
      [migration.hash, migration.folderMillis],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  let primaryFailure: unknown;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      migrationLockName,
    ]);
    locked = true;
    await assertFreshDatabaseWhenUnmanaged(client);
    await prepareLedger(client);

    const migrations = readMigrationFiles({
      migrationsFolder: migrationsFolder(),
    });
    const applied = await readAppliedMigrations(client);
    assertMigrationSequence(migrations, applied);

    for (const migration of migrations.slice(applied.length)) {
      await applyMigration(client, migration);
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let destroyClient = false;
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock(hashtext($1))", [
          migrationLockName,
        ]);
      }
    } catch (unlockFailure) {
      destroyClient = true;
      if (primaryFailure === undefined) throw unlockFailure;
    } finally {
      client.release(destroyClient);
    }
  }
}

export async function assertMigrationsCurrent(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  let primaryFailure: unknown;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      migrationLockName,
    ]);
    locked = true;
    if (!(await ledgerExists(client))) {
      throw new Error("The Drizzle migration ledger is missing.");
    }
    const migrations = readMigrationFiles({
      migrationsFolder: migrationsFolder(),
    });
    const applied = await readAppliedMigrations(client);
    assertMigrationSequence(migrations, applied);
    if (applied.length !== migrations.length) {
      throw new Error(
        `The database is missing ${migrations.length - applied.length} bundled migration(s).`,
      );
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let destroyClient = false;
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock(hashtext($1))", [
          migrationLockName,
        ]);
      }
    } catch (unlockFailure) {
      destroyClient = true;
      if (primaryFailure === undefined) throw unlockFailure;
    } finally {
      client.release(destroyClient);
    }
  }
}

async function main(): Promise<void> {
  requireDatabaseConfiguration();
  const pool = createDatabasePool();
  try {
    await runMigrations(pool);
    process.stdout.write("Database migration completed.\n");
  } finally {
    await pool.end();
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  pathToFileURL(resolve(entryPoint)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  main().catch((error) => reportStartupFailure(toDatabaseStartupError(error)));
}
