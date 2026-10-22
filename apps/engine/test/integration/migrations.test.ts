import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations as applyMigrations } from "../../src/database/migrate.js";
import {
  type DisposableTestDatabase,
  provisionTestDatabase,
} from "./support/database.js";

async function runMigrations(database: DisposableTestDatabase): Promise<void> {
  await applyMigrations(database.pool);
}

const EXPECTED_PUBLIC_TABLES = [
  "accounts",
  "activities",
  "activity_events",
  "activity_goal_allocations",
  "admin_audit_actor_aliases",
  "admin_audit_events",
  "automation_jobs",
  "automation_settings",
  "automation_worker_heartbeats",
  "brain_handoffs",
  "briefing_actions",
  "decision_embeddings",
  "decision_people",
  "decisions",
  "dreaming_change_evidence",
  "dreaming_changes",
  "dreaming_evidence",
  "dreaming_reports",
  "dreaming_reviews",
  "dreaming_runs",
  "embedding_spaces",
  "environment_configuration",
  "environment_configuration_changes",
  "environment_configuration_restart_requests",
  "goal_versions",
  "goals",
  "ingest_proposals",
  "ingest_receipts",
  "ingest_review_items",
  "ingest_reviews",
  "ingest_runs",
  "ingest_sources",
  "knowledge_bases",
  "knowledge_chunk_embeddings",
  "knowledge_chunks",
  "knowledge_document_people",
  "knowledge_document_revisions",
  "knowledge_documents",
  "knowledge_pack_artifacts",
  "knowledge_pack_items",
  "knowledge_pack_mappings",
  "knowledge_pack_revisions",
  "knowledge_pack_run_chunks",
  "knowledge_pack_run_items",
  "knowledge_pack_runs",
  "knowledge_packs",
  "knowledge_revision_contents",
  "knowledge_revision_origins",
  "memories",
  "memory_embeddings",
  "memory_people",
  "model_requests",
  "model_runtime_instances",
  "mutation_receipts",
  "notification_channels",
  "oauth_artifacts",
  "oauth_settings",
  "people",
  "person_knowledge_bases",
  "person_projects",
  "priority_plan_version_items",
  "priority_plan_versions",
  "priority_plans",
  "projects",
  "reminder_deliveries",
  "reminder_versions",
  "reminders",
  "task_goal_links",
  "task_lists",
  "task_relations",
  "task_version_goal_links",
  "task_versions",
  "tasks",
] as const;

describe("fresh Drizzle database", () => {
  let database: DisposableTestDatabase;

  beforeAll(async () => {
    database = await provisionTestDatabase("migration");
    await runMigrations(database);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  });

  it("installs the required extensions", async () => {
    const result = await database.pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('btree_gist', 'pgcrypto', 'vector') ORDER BY extname",
    );

    expect(result.rows.map((row) => row.extname)).toEqual([
      "btree_gist",
      "pgcrypto",
      "vector",
    ]);
  });

  it("creates the complete v1 schema without legacy migration tables", async () => {
    const result = await database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );

    const tableNames = result.rows.map((row) => row.tablename).sort();
    expect(tableNames).toEqual(EXPECTED_PUBLIC_TABLES);
    expect(tableNames).not.toEqual(
      expect.arrayContaining(["oauth_users", "schema_migrations"]),
    );

    const legacyOwnershipColumns = await database.pool.query<{
      column_name: string;
      table_name: string;
    }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'owner_id'
      ORDER BY table_name
    `);
    expect(legacyOwnershipColumns.rows).toEqual([]);
  });

  it("removes every persisted brain identifier", async () => {
    const brainColumns = await database.pool.query<{
      table_name: string;
    }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'brain_id'
      ORDER BY table_name
    `);
    expect(brainColumns.rows).toEqual([]);

    const legacyTables = await database.pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('brains', 'brain_memberships', 'account_brain_preferences')
      ORDER BY table_name
    `);
    expect(legacyTables.rows).toEqual([]);

    const legacyTypes = await database.pool.query<{ type_name: string }>(`
      SELECT t.typname AS type_name
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typtype = 'e'
        AND t.typname IN ('brain_kind', 'membership_status', 'priority_plan_scope')
      ORDER BY type_name
    `);
    expect(legacyTypes.rows).toEqual([]);

    const brainFunctions = await database.pool.query<{ routine_name: string }>(`
      SELECT p.proname AS routine_name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
        AND pg_catalog.pg_get_functiondef(p.oid) ILIKE '%brain_id%'
      ORDER BY routine_name
    `);
    expect(brainFunctions.rows).toEqual([]);
  });

  it("stores the account role and singleton automation settings", async () => {
    const accountRole = await database.pool.query<{
      column_default: string | null;
      column_name: string;
      data_type: string;
      is_nullable: string;
      udt_name: string;
    }>(`
      SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'accounts'
        AND column_name = 'role'
    `);
    expect(accountRole.rows).toEqual([
      {
        column_default: null,
        column_name: "role",
        data_type: "USER-DEFINED",
        is_nullable: "NO",
        udt_name: "membership_role",
      },
    ]);

    const settings = await database.pool.query<{
      id: number;
      time_zone: string;
    }>(`
      SELECT id, time_zone FROM automation_settings WHERE id = 1
    `);
    expect(settings.rows).toEqual([]);
  });

  it("installs the migration-only relational invariants", async () => {
    const constraints = await database.pool.query<{ constraint_name: string }>(`
      SELECT con.conname AS constraint_name
      FROM pg_constraint con
      JOIN pg_namespace namespace ON namespace.oid = con.connamespace
      WHERE namespace.nspname = 'public'
        AND con.conname IN (
          'knowledge_documents_current_revision_fkey',
          'priority_plans_current_version_fkey',
          'priority_plans_general_period_exclusion',
          'priority_plans_project_period_exclusion'
        )
      ORDER BY con.conname
    `);
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      "knowledge_documents_current_revision_fkey",
      "priority_plans_current_version_fkey",
      "priority_plans_general_period_exclusion",
      "priority_plans_project_period_exclusion",
    ]);

    const triggers = await database.pool.query<{ trigger_name: string }>(`
      SELECT trigger.tgname AS trigger_name
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND NOT trigger.tgisinternal
        AND trigger.tgname IN (
          'automation_settings_time_zone_trigger',
          'activity_goal_allocations_total_trigger',
          'priority_plan_items_set_trigger',
          'priority_plan_versions_items_trigger'
        )
      ORDER BY trigger.tgname
    `);
    expect(triggers.rows.map((row) => row.trigger_name)).toEqual([
      "activity_goal_allocations_total_trigger",
      "automation_settings_time_zone_trigger",
      "priority_plan_items_set_trigger",
      "priority_plan_versions_items_trigger",
    ]);
  });

  it("records the generated migration and can run it again", async () => {
    const before = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );

    await runMigrations(database);

    const after = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );
    expect(before.rows).toEqual([{ count: "10" }]);
    expect(after.rows).toEqual(before.rows);
  });

  it("serializes concurrent migration attempts without polling sleeps", async () => {
    const concurrentDatabase = await provisionTestDatabase(
      "concurrent_migration",
    );
    try {
      await Promise.all([
        runMigrations(concurrentDatabase),
        runMigrations(concurrentDatabase),
      ]);
      const result = await concurrentDatabase.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
      );
      expect(result.rows).toEqual([{ count: "10" }]);
    } finally {
      await concurrentDatabase.destroy();
    }
  }, 300_000);

  it("refuses to layer the fresh v1 schema onto a legacy public schema", async () => {
    const legacyDatabase = await provisionTestDatabase("legacy_refusal");
    try {
      await legacyDatabase.pool.query(
        "CREATE TABLE oauth_users (id text PRIMARY KEY)",
      );
      await expect(runMigrations(legacyDatabase)).rejects.toThrow(
        /empty database|fresh.*database|database.*not empty/iu,
      );
      const v1Tables = await legacyDatabase.pool.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'accounts'
      `);
      expect(v1Tables.rows).toEqual([]);
    } finally {
      await legacyDatabase.destroy();
    }
  });

  it("rolls back every statement when a migration fails", async () => {
    const rollbackDatabase = await provisionTestDatabase("migration_rollback");
    try {
      await rollbackDatabase.pool.query("CREATE SCHEMA migration_test");
      await rollbackDatabase.pool.query(`
        CREATE FUNCTION migration_test.fail_accounts_table()
        RETURNS event_trigger
        LANGUAGE plpgsql
        AS $body$
        BEGIN
          IF current_query() ILIKE '%CREATE TABLE "accounts"%' THEN
            RAISE EXCEPTION 'injected migration failure';
          END IF;
        END
        $body$
      `);
      await rollbackDatabase.pool.query(`
        CREATE EVENT TRIGGER migration_test_fail_accounts
        ON ddl_command_start
        EXECUTE FUNCTION migration_test.fail_accounts_table()
      `);

      await expect(runMigrations(rollbackDatabase)).rejects.toThrow(
        "injected migration failure",
      );
      const publicTables = await rollbackDatabase.pool.query<{
        count: string;
      }>(`
        SELECT count(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);
      const migrationRecords = await rollbackDatabase.pool.query<{
        count: string;
      }>("SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations");
      expect(publicTables.rows).toEqual([{ count: "0" }]);
      expect(migrationRecords.rows).toEqual([{ count: "0" }]);
    } finally {
      await rollbackDatabase.destroy();
    }
  });

  it("rejects an edited applied migration checksum", async () => {
    const checksumDatabase = await provisionTestDatabase("checksum_mismatch");
    try {
      await runMigrations(checksumDatabase);
      await checksumDatabase.pool.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = repeat('0', 64)",
      );
      await expect(runMigrations(checksumDatabase)).rejects.toThrow(
        "Migration checksum mismatch",
      );
    } finally {
      await checksumDatabase.destroy();
    }
  }, 240_000);

  it("rejects reordered and unknown migration ledger entries", async () => {
    const ledgerDatabase = await provisionTestDatabase("ledger_order");
    try {
      await runMigrations(ledgerDatabase);
      await ledgerDatabase.pool.query(
        "UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 1",
      );
      await expect(runMigrations(ledgerDatabase)).rejects.toThrow(
        "Migration order mismatch",
      );

      await ledgerDatabase.pool.query(
        "UPDATE drizzle.__drizzle_migrations SET created_at = created_at - 1",
      );
      await ledgerDatabase.pool.query(
        `
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          SELECT repeat('f', 64), max(created_at) + 1
          FROM drizzle.__drizzle_migrations
        `,
      );
      await expect(runMigrations(ledgerDatabase)).rejects.toThrow(
        "migrations unknown to this build",
      );
    } finally {
      await ledgerDatabase.destroy();
    }
  }, 240_000);

  it("keeps vector data in embedding sidecars with fixed dimensions", async () => {
    const result = await database.pool.query<{
      column_name: string;
      formatted_type: string;
      table_name: string;
    }>(`
      SELECT
        table_name,
        column_name,
        format_type(a.atttypid, a.atttypmod) AS formatted_type
      FROM information_schema.columns c
      JOIN pg_class cl ON cl.relname = c.table_name
      JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = c.table_schema
      JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.udt_name = 'vector'
      ORDER BY table_name, column_name
    `);

    expect(result.rows).toEqual([
      {
        table_name: "decision_embeddings",
        column_name: "embedding",
        formatted_type: "vector(1536)",
      },
      {
        table_name: "knowledge_chunk_embeddings",
        column_name: "embedding",
        formatted_type: "vector(1536)",
      },
      {
        table_name: "knowledge_pack_run_chunks",
        column_name: "embedding",
        formatted_type: "vector(1536)",
      },
      {
        table_name: "memory_embeddings",
        column_name: "embedding",
        formatted_type: "vector(1536)",
      },
    ]);

    const indexes = await database.pool.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef ILIKE '% USING hnsw %'
        AND indexdef ILIKE '%vector_cosine_ops%'
      ORDER BY tablename
    `);
    expect(indexes.rows.map((row) => row.tablename)).toEqual([
      "decision_embeddings",
      "knowledge_chunk_embeddings",
      "memory_embeddings",
    ]);
  });
});
