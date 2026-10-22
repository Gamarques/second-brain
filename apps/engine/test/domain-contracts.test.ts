import { describe, expect, it } from "vitest";
import { expectTypeOf } from "vitest";

import type {
  ActorAttribution,
  DreamingRun,
  DreamingSettings,
  DreamingStore,
  IngestionProvider,
  IngestReview,
  IngestSource,
  MutationSource,
} from "../src/domain.js";

import {
  actorAttributionSchema,
  actorProvenanceSchema,
  automationJobKindsFilterSchema,
} from "../src/capabilities/schemas.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

describe("actor provenance contracts", () => {
  it("exposes only supported clean-v1 mutation channels", () => {
    expectTypeOf<MutationSource>().toEqualTypeOf<
      "direct" | "mcp_http" | "automation" | "import"
    >();
    expectTypeOf<
      Extract<MutationSource, "cli" | "mcp_stdio">
    >().toEqualTypeOf<never>();
    expect(
      actorAttributionSchema.safeParse({
        kind: "account",
        accountId,
        clientId: null,
        source: "cli",
      }).success,
    ).toBe(false);
    expect(
      actorAttributionSchema.safeParse({
        kind: "account",
        accountId,
        clientId: null,
        source: "mcp_stdio",
      }).success,
    ).toBe(false);
  });

  it("accepts live interactive writes and historical erasure tombstones", () => {
    expect(
      actorProvenanceSchema.safeParse({
        kind: "oauth_client",
        accountId,
        clientId: "codex",
        source: "mcp_http",
        requestId: "request-1",
        correlationId: null,
        causationId: null,
        dreamingRunId: null,
      }).success,
    ).toBe(true);
    expect(
      actorAttributionSchema.safeParse({
        kind: "oauth_client",
        accountId: null,
        clientId: null,
        source: "mcp_http",
      }).success,
    ).toBe(true);
  });

  it("requires internal dreaming provenance without a human identity", () => {
    expect(
      actorProvenanceSchema.safeParse({
        kind: "dreaming",
        accountId: null,
        clientId: null,
        source: "automation",
        requestId: "request-2",
        correlationId: null,
        causationId: "daily:2026-08-15",
        dreamingRunId: runId,
      }).success,
    ).toBe(true);
    expect(
      actorProvenanceSchema.safeParse({
        kind: "dreaming",
        accountId,
        clientId: null,
        source: "automation",
        requestId: "request-2",
        correlationId: null,
        causationId: "daily:2026-08-15",
        dreamingRunId: runId,
      }).success,
    ).toBe(false);
  });

  it("rejects partially redacted OAuth attribution", () => {
    expect(
      actorAttributionSchema.safeParse({
        kind: "oauth_client",
        accountId: null,
        clientId: "stale-client",
        source: "mcp_http",
      }).success,
    ).toBe(false);
  });
});

describe("automation worker contracts", () => {
  it("requires every worker claim to name at least one job kind", () => {
    expect(automationJobKindsFilterSchema.safeParse([]).success).toBe(false);
    expect(
      automationJobKindsFilterSchema.safeParse(["daily_dreaming"]).success,
    ).toBe(true);
    expect(
      automationJobKindsFilterSchema.safeParse([
        "daily_dreaming",
        "reminder_delivery",
      ]).success,
    ).toBe(true);
  });
});

describe("erasure-safe ingestion contracts", () => {
  it("stores historical attribution rather than live request provenance", () => {
    expectTypeOf<
      IngestSource["provenance"]
    >().toEqualTypeOf<ActorAttribution>();
    expectTypeOf<
      IngestReview["provenance"]
    >().toEqualTypeOf<ActorAttribution>();

    expect(
      actorAttributionSchema.safeParse({
        kind: "account",
        accountId: null,
        clientId: null,
        source: "direct",
      }).success,
    ).toBe(true);
  });
});

describe("ingestion provider contracts", () => {
  it("exposes unambiguous ingestion identity before inference", () => {
    expectTypeOf<
      IngestionProvider["ingestionProvider"]
    >().toEqualTypeOf<string>();
    expectTypeOf<IngestionProvider["ingestionModel"]>().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<IngestionProvider["propose"]>>
    >().toMatchTypeOf<{
      readonly provider: string;
      readonly model: string;
    }>();
  });
});

describe("dreaming token-limit contracts", () => {
  it("keeps technical token limits without local USD accounting", () => {
    type HasKey<Value, Key extends PropertyKey> = Key extends keyof Value
      ? true
      : false;
    type SavePlanInput = Parameters<DreamingStore["savePlan"]>[1];

    expectTypeOf<
      DreamingSettings["dailyInputTokenLimit"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      DreamingSettings["dailyOutputTokenLimit"]
    >().toEqualTypeOf<number>();
    expectTypeOf<DreamingRun["inputTokens"]>().toEqualTypeOf<number>();
    expectTypeOf<DreamingRun["outputTokens"]>().toEqualTypeOf<number>();
    expectTypeOf<
      HasKey<DreamingSettings, "dailyCostLimitUsd">
    >().toEqualTypeOf<false>();
    expectTypeOf<HasKey<DreamingRun, "costUsd">>().toEqualTypeOf<false>();
    expectTypeOf<HasKey<SavePlanInput, "costUsd">>().toEqualTypeOf<false>();
  });
});
