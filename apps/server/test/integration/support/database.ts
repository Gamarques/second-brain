import { randomBytes } from "node:crypto";

import { Pool } from "pg";

const TEST_DATABASE_PREFIX = "second_brain_test_";
const TEST_DATABASE_NAME = /^second_brain_test_[a-z0-9_]+$/u;

export interface DisposableTestDatabase {
  readonly name: string;
  readonly pool: Pool;
  readonly url: string;
  destroy(): Promise<void>;
}

export function requireTestAdminUrl(): string {
  const value = process.env.TEST_DATABASE_ADMIN_URL;
  if (!value) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL is required for PostgreSQL integration tests. " +
        "Use scripts/run-postgres-tests.mjs for an isolated Docker database.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("TEST_DATABASE_ADMIN_URL must be a valid PostgreSQL URL.", {
      cause: error,
    });
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("TEST_DATABASE_ADMIN_URL must use the postgresql protocol.");
  }
  return value;
}

export function validateTestDatabaseName(name: string): string {
  if (!TEST_DATABASE_NAME.test(name) || name.length > 63) {
    throw new Error(
      `Refusing to manage database ${JSON.stringify(name)}: test database names must start with ${TEST_DATABASE_PREFIX}.`,
    );
  }
  return name;
}

function targetUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function provisionTestDatabase(
  label = "schema",
): Promise<DisposableTestDatabase> {
  const adminUrl = requireTestAdminUrl();
  const safeLabel = label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_").replaceAll(/^_+|_+$/gu, "");
  const name = validateTestDatabaseName(
    `${TEST_DATABASE_PREFIX}${safeLabel || "db"}_${process.pid}_${randomBytes(6).toString("hex")}`,
  );
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  // Idle clients emit "error" when DROP ... WITH (FORCE) races their graceful
  // shutdown; without a listener Node surfaces that as an unhandled error.
  adminPool.on("error", () => undefined);
  let pool: Pool | undefined;
  let destroyed = false;

  async function destroyResources(): Promise<void> {
    if (destroyed) return;
    destroyed = true;
    const failures: unknown[] = [];
    try {
      await pool?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (error) {
      failures.push(error);
    }
    try {
      await adminPool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to destroy test database ${name}.`);
    }
  }

  try {
    await adminPool.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`);
    const url = targetUrl(adminUrl, name);
    pool = new Pool({ connectionString: url, max: 4 });
    pool.on("error", () => undefined);

    return {
      name,
      pool,
      url,
      destroy: destroyResources,
    };
  } catch (error) {
    await destroyResources().catch(() => undefined);
    throw error;
  }
}
