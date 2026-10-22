import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createSecondBrainEngine } from "../src/engine.js";
import { SECOND_BRAIN_VERSION } from "../src/version.js";
import { boundaryDependencies } from "./support/engine-dependencies.js";

const expectedCapabilityIds = [
  "task_lists_create",
  "task_lists_list",
  "tasks_create",
  "tasks_list",
  "tasks_update",
  "tasks_delete",
  "tasks_history_list",
  "task_relations_create",
  "memories_create",
  "memories_update",
  "memories_search",
  "memories_list",
  "memories_delete",
  "reminders_create",
  "reminders_list",
  "reminders_update",
  "reminders_delete",
  "reminders_history_list",
  "knowledge_bases_create",
  "knowledge_bases_list",
  "knowledge_documents_list",
  "knowledge_documents_get",
  "knowledge_document_revisions_create",
  "knowledge_document_revisions_list",
  "knowledge_ask",
  "knowledge_packs_export",
  "knowledge_packs_export_get",
  "knowledge_packs_import",
  "knowledge_packs_import_get",
  "knowledge_packs_import_review",
  "knowledge_packs_import_publish",
  "knowledge_packs_runs_list",
  "knowledge_packs_runs_cancel",
  "knowledge_packs_runs_retry",
  "projects_create",
  "projects_list",
  "projects_update",
  "people_create",
  "people_list",
  "people_update",
  "decisions_create",
  "decisions_list",
  "decisions_revoke",
  "goals_create",
  "goals_update",
  "goals_list",
  "goals_history",
  "priorities_create",
  "priorities_update",
  "priorities_list",
  "activities_record",
  "activities_list",
  "activities_retract",
  "activities_summary",
  "brain_ask",
  "brain_search",
  "ingestion_propose",
  "ingestion_review",
  "ingestion_commit",
  "ingestion_status",
  "context_get",
  "handoffs_create",
  "handoffs_list",
  "dreaming_report_get",
] as const;

describe("second-brain engine boundary", () => {
  it("publishes the clean v1 catalog and no legacy ingestion capability", () => {
    const engine = createSecondBrainEngine(boundaryDependencies());

    expect(engine.name).toBe("second-brain");
    expect(engine.version).toBe(SECOND_BRAIN_VERSION);
    expect(engine.list().map(({ id }) => id)).toEqual(expectedCapabilityIds);
    expect(new Set(expectedCapabilityIds).size).toBe(expectedCapabilityIds.length);
    expect(expectedCapabilityIds.some((id) => id.startsWith("brain_ingest"))).toBe(false);
    for (const id of expectedCapabilityIds) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }

    const manifest = JSON.parse(
      readFileSync(
        new URL("../invokta.mcp.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly capabilityIds: readonly string[] };
    expect(manifest.capabilityIds).toEqual(expectedCapabilityIds);
  });

  it("keeps dreaming execution internal and exposes only its report", () => {
    const engine = createSecondBrainEngine(boundaryDependencies());
    const dreamingCapabilities = engine
      .list()
      .map(({ id }) => id)
      .filter((id) => id.startsWith("dreaming_"));

    expect(dreamingCapabilities).toEqual(["dreaming_report_get"]);
  });

  it("keeps the shared engine authentication boundary fail-closed", async () => {
    const engine = createSecondBrainEngine(boundaryDependencies());

    await expect(
      engine.invoke("task_lists_list", {}, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects the removed brain selector without publishing it", async () => {
    const engine = createSecondBrainEngine(boundaryDependencies());
    const principal = { id: "00000000-0000-4000-8000-000000000001" };

    for (const capabilityId of expectedCapabilityIds) {
      expect(JSON.stringify(engine.describe(capabilityId).inputSchema)).not.toContain(
        "brainId",
      );
      await expect(
        engine.invoke(
          capabilityId,
          { brainId: "00000000-0000-4000-8000-000000000002" } as never,
          { principal },
        ),
      ).rejects.toMatchObject({
        code: "INPUT_INVALID",
        publicDetails: {
          issues: expect.arrayContaining([
            {
              message: "brainId is not supported by this single-brain deployment.",
              path: ["brainId"],
            },
          ]),
        },
      });
    }
  });
});
