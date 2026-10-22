import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface DrizzleJournal {
  readonly entries: readonly { readonly tag: string }[];
}

async function journalEntries(): Promise<readonly string[]> {
  const journal = JSON.parse(
    await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as DrizzleJournal;
  const tags = journal.entries.map((entry) => entry.tag);
  expect(tags.length).toBeGreaterThanOrEqual(1);
  for (const tag of tags) expect(tag).toBeTypeOf("string");
  return tags;
}

async function migrationSql(tag: string): Promise<string> {
  return readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
}

async function baselineSql(): Promise<string> {
  const entries = await journalEntries();
  expect(entries[0]).toBe("0000_initial_schema");
  return migrationSql(entries[0]!);
}

describe("clean v1 Drizzle baseline", () => {
  it("pins extensions and advanced PostgreSQL integrity constraints", async () => {
    const sql = await baselineSql();

    for (const fragment of [
      "CREATE EXTENSION IF NOT EXISTS pgcrypto",
      "CREATE EXTENSION IF NOT EXISTS vector",
      "CREATE EXTENSION IF NOT EXISTS btree_gist",
      'CONSTRAINT "knowledge_documents_current_revision_fkey"',
      'CONSTRAINT "priority_plans_current_version_fkey"',
      'CONSTRAINT "priority_plans_general_period_exclusion"',
      'CONSTRAINT "priority_plans_project_period_exclusion"',
      'CREATE TRIGGER "automation_settings_time_zone_trigger"',
      'CREATE CONSTRAINT TRIGGER "activity_goal_allocations_total_trigger"',
      'CREATE CONSTRAINT TRIGGER "priority_plan_items_set_trigger"',
      "FOR UPDATE",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it("is the only fresh-install baseline and contains no legacy tenancy", async () => {
    const sql = await baselineSql();

    expect(sql).toContain("Clean v1 migrations require an empty public schema.");
    expect(sql).toContain('CREATE TABLE "automation_settings"');
    expect(sql).not.toContain('CREATE TABLE "dreaming_settings"');
    expect(sql).not.toContain('CREATE TABLE "brains"');
    expect(sql).not.toContain('CREATE TABLE "brain_memberships"');
    expect(sql).not.toContain('CREATE TABLE "account_brain_preferences"');
    expect(sql).not.toContain('"brain_id"');
    expect(sql).not.toContain('"brain_kind"');
    expect(sql).not.toContain('"membership_status"');
    expect(sql).not.toContain('"priority_plan_scope"');
    expect(sql).not.toContain("owner_id");
    expect(sql).not.toContain("oauth_users");
  });

  it("adds discovery links without editing the v1 baseline", async () => {
    const entries = await journalEntries();
    expect(entries[0]).toBe("0000_initial_schema");
    expect(entries).toContain("0001_discovery_links");
    const sql = await migrationSql("0001_discovery_links");
    expect(sql).toContain("person_projects");
    expect(sql).toContain("person_knowledge_bases");
    expect(sql).toContain("knowledge_document_people");
  });

  it("keeps dreaming limits token-only and records supported mutation sources", async () => {
    const sql = await baselineSql();

    expect(sql).toContain(
      `CREATE TYPE "public"."mutation_source" AS ENUM('direct', 'mcp_http', 'automation', 'import')`,
    );
    expect(sql).toContain('CONSTRAINT "automation_settings_token_limits_check"');
    expect(sql).not.toContain("budget_check");
    expect(sql).not.toContain("daily_cost_limit_usd");
    expect(sql).not.toContain("cost_usd");
    expect(sql).not.toContain("'cli'");
    expect(sql).not.toContain("'mcp_stdio'");
  });
});

describe("Brain Pack migration", () => {
  it("adds the pack tables, job kinds and immutable origin links without touching earlier migrations", async () => {
    const entries = await journalEntries();
    expect(entries).toContain("0008_brain_pack");
    const sql = await migrationSql("0008_brain_pack");

    for (const table of [
      "knowledge_pack_artifacts",
      "knowledge_packs",
      "knowledge_pack_revisions",
      "knowledge_pack_items",
      "knowledge_pack_mappings",
      "knowledge_revision_origins",
      "knowledge_revision_contents",
      "knowledge_pack_runs",
      "knowledge_pack_run_items",
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain(`ALTER TYPE "public"."automation_job_kind" ADD VALUE 'brain_pack_export'`);
    expect(sql).toContain(`ALTER TYPE "public"."automation_job_kind" ADD VALUE 'brain_pack_import'`);
    expect(sql).toContain('"knowledge_pack_mappings_identity_key" UNIQUE("pack_id","item_key")');
    expect(sql).toContain('"knowledge_revision_origins_revision_key" UNIQUE("revision_id")');
    expect(sql).toContain('CREATE TRIGGER "knowledge_revision_origins_immutable_trigger"');
    expect(sql).toContain('"bytes" "bytea" NOT NULL');
    expect(sql).not.toContain("DROP TABLE");
  });
});

describe("Brain Pack staging migration", () => {
  it("adds the staging table that holds chunks and vectors until a pack import publishes", async () => {
    const entries = await journalEntries();
    expect(entries.indexOf("0009_brain_pack_staging")).toBe(entries.indexOf("0008_brain_pack") + 1);
    const sql = await migrationSql("0009_brain_pack_staging");

    expect(sql).toContain('CREATE TABLE "knowledge_pack_run_chunks"');
    expect(sql).toContain('"embedding" vector(1536) NOT NULL');
    expect(sql).toContain('"knowledge_pack_run_chunks_position_key" UNIQUE("run_item_id","position")');
    expect(sql).toContain("ON DELETE cascade");
    expect(sql).not.toContain("DROP TABLE");
  });
});

