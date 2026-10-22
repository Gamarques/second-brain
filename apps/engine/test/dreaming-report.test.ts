import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createDreamingReportCapabilities } from "../src/capabilities/dreaming-report.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  DreamingReport,
  DreamingStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const reportId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const memoryId = "00000000-0000-4000-8000-000000000005";
const previousMemoryId = "00000000-0000-4000-8000-000000000006";
const evidenceId = "00000000-0000-4000-8000-000000000007";

const access: BrainAccessContext = {
  accountId,
  role: "viewer",
  actor: {
    kind: "account",
    accountId,
    clientId: null,
    source: "direct",
    requestId: "request-1",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

const report: DreamingReport = {
  id: reportId,
  runId,
  localDate: "2026-08-15",
  generatedAt: "2026-08-16T03:00:00.000Z",
  mode: "apply",
  status: "completed_with_skips",
  summary: "The day reinforced the launch focus and exposed one open loop.",
  insights: [
    {
      kind: "open_loop",
      statement: "The distribution plan still has no owner.",
      confidence: "high",
      evidence: [
        {
          type: "task",
          id: evidenceId,
          versionId: null,
          excerpt: "Assign an owner to the distribution plan.",
        },
      ],
    },
  ],
  memoriesCreated: [
    { id: memoryId, content: "Distribution ownership is unresolved." },
  ],
  memoriesUpdated: [
    {
      id: memoryId,
      previousMemoryId,
      content: "The launch remains the primary focus.",
    },
  ],
  skipped: [{ reason: "A proposed update lacked supporting evidence." }],
  coverageWarnings: ["One activity excluded itself from analysis."],
};

function createSubject() {
  const accessRequests: BrainAccessRequest[] = [];
  const selectors: unknown[] = [];
  const accessStore = {
    async resolveAccess(request: BrainAccessRequest) {
      accessRequests.push(request);
      return {
        ...access,
        actor: {
          ...access.actor,
          source: request.source,
          requestId: request.requestId,
        },
      };
    },
  } as unknown as BrainAccessStore;
  const dreamingStore = {
    async getReport(_access: BrainAccessContext, selector: unknown) {
      selectors.push(selector);
      return report;
    },
    claimRun: vi.fn(() => {
      throw new Error("The public capability must never claim a dreaming run.");
    }),
  } as unknown as DreamingStore;
  const capabilities = createDreamingReportCapabilities(
    accessStore,
    dreamingStore,
  );
  const engine = createEngine({
    name: "dreaming-report-test",
    version: "1.0.0",
    capabilities,
  });
  return { accessRequests, capabilities, dreamingStore, engine, selectors };
}

describe("dreaming_report_get", () => {
  it("exposes only the bounded report read surface and never a run trigger", async () => {
    const { capabilities, dreamingStore, engine } = createSubject();

    expect(Object.keys(capabilities)).toEqual(["dreaming_report_get"]);
    expect(engine.list()).toEqual([
      expect.objectContaining({
        id: "dreaming_report_get",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      }),
    ]);
    expect(engine.describe("dreaming_report_get").timeoutMs).toBe(30_000);

    await expect(
      engine.invoke(
        "dreaming_report_get",
        {},
        { principal: { id: accountId } },
      ),
    ).resolves.toEqual({ report });
    expect(dreamingStore.claimRun).not.toHaveBeenCalled();
  });

  it("selects the latest report by default and requires viewer access", async () => {
    const { accessRequests, engine, selectors } = createSubject();

    await engine.invoke(
      "dreaming_report_get",
      {},
      {
        principal: { id: accountId },
        requestId: "report-request",
        source: "mcp-http",
      },
    );

    expect(accessRequests).toEqual([
      expect.objectContaining({
        principal: { id: accountId },
        requiredRole: "viewer",
        requestId: "report-request",
        source: "mcp_http",
      }),
    ]);
    expect(selectors).toEqual([{ kind: "latest" }]);
  });

  it("supports mutually exclusive local-date and run-id selectors", async () => {
    const { engine, selectors } = createSubject();

    await engine.invoke(
      "dreaming_report_get",
      { localDate: "2026-08-15" },
      { principal: { id: accountId } },
    );
    await engine.invoke(
      "dreaming_report_get",
      { runId },
      { principal: { id: accountId } },
    );

    expect(selectors).toEqual([
      { kind: "local_date", localDate: "2026-08-15" },
      { kind: "run_id", runId },
    ]);
    await expect(
      engine.invoke(
        "dreaming_report_get",
        { localDate: "2026-08-15", runId },
        { principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("returns an explicit empty result without triggering work when no report matches", async () => {
    const { engine } = createSubject();
    const emptyStore = {
      getReport: vi.fn(async () => null),
    } as unknown as DreamingStore;
    const emptyEngine = createEngine({
      name: "empty-dreaming-report-test",
      version: "1.0.0",
      capabilities: createDreamingReportCapabilities(
        {
          resolveAccess: vi.fn(async (request: BrainAccessRequest) => ({
            ...access,
            actor: {
              ...access.actor,
              source: request.source,
              requestId: request.requestId,
            },
          })),
        } as unknown as BrainAccessStore,
        emptyStore,
      ),
    });

    await expect(
      emptyEngine.invoke(
        "dreaming_report_get",
        {},
        { principal: { id: accountId } },
      ),
    ).resolves.toEqual({ report: null });
    expect(engine.list()).toHaveLength(1);
  });

  it("rejects unauthenticated calls before consulting either store", async () => {
    const { accessRequests, engine, selectors } = createSubject();

    await expect(
      engine.invoke("dreaming_report_get", {}),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(accessRequests).toEqual([]);
    expect(selectors).toEqual([]);
  });
});
