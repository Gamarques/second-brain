import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createContextCapabilities } from "../src/capabilities/context.js";
import { encodeCursor } from "../src/capabilities/schemas.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  BrainContextSnapshot,
  BrainHandoff,
  ContextStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000101";
const handoffId = "00000000-0000-4000-8000-000000000103";
const taskId = "00000000-0000-4000-8000-000000000104";
const createdAt = "2026-08-16T12:00:00.000Z";

const actor = {
  kind: "account" as const,
  accountId,
  clientId: null,
  source: "mcp_http" as const,
  requestId: "request-1",
  correlationId: null,
  causationId: null,
  dreamingRunId: null,
};

const access: BrainAccessContext = {
  accountId,
  role: "editor",
  actor,
};

const snapshot: BrainContextSnapshot = {
  generatedAt: createdAt,
  asOf: createdAt,
  purpose: "Continue the launch work",
  currentPriorities: [],
  activeGoals: [],
  activeDecisions: [],
  relevantMemories: [],
  openTasks: [],
  pendingReminders: [],
  knowledgeBases: [],
  peopleIndex: [],
  coverage: {
    completeFrom: "2026-01-01T00:00:00.000Z",
    requestedAsOf: createdAt,
    complete: true,
    warnings: [],
  },
};

const handoff: BrainHandoff = {
  id: handoffId,
  fromClientId: null,
  title: "Launch handoff",
  summary: "The release is ready for review.",
  nextActions: ["Review the release notes."],
  entityRefs: [{ type: "task", id: taskId }],
  provenance: actor,
  createdAt,
  expiresAt: null,
};

function createSubject() {
  const accessRequests: BrainAccessRequest[] = [];
  const contextCalls: unknown[] = [];
  const createCalls: unknown[] = [];
  const listCalls: unknown[] = [];
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
  const contextStore = {
    async loadContext(_access: BrainAccessContext, input: unknown) {
      contextCalls.push(input);
      return snapshot;
    },
    async createHandoff(_access: BrainAccessContext, input: unknown) {
      createCalls.push(input);
      return handoff;
    },
    async listHandoffs(_access: BrainAccessContext, input: unknown) {
      listCalls.push(input);
      return {
        items: [handoff],
        nextCursor: { ts: createdAt, id: handoffId },
      };
    },
  } as unknown as ContextStore;
  const capabilities = createContextCapabilities(accessStore, contextStore);
  const engine = createEngine({
    name: "context-test",
    version: "1.0.0",
    capabilities,
  });
  return {
    accessRequests,
    capabilities,
    contextCalls,
    createCalls,
    engine,
    listCalls,
  };
}

describe("context continuity capabilities", () => {
  it("loads an explicitly bounded context snapshot with viewer access", async () => {
    const { accessRequests, contextCalls, engine } = createSubject();

    await expect(
      engine.invoke(
        "context_get",
        {
          purpose: "  Continue the launch work  ",
          asOf: createdAt,
          limits: {
            memories: 8,
            decisions: 7,
            tasks: 12,
            reminders: 6,
            goals: 5,
          },
        },
        {
          principal: { id: accountId },
          requestId: "context-request",
          source: "mcp-http",
        },
      ),
    ).resolves.toEqual(snapshot);

    expect(accessRequests[0]).toEqual(
      expect.objectContaining({
        requiredRole: "viewer",
        requestId: "context-request",
        source: "mcp_http",
      }),
    );
    expect(contextCalls).toEqual([
      {
        purpose: "Continue the launch work",
        asOf: createdAt,
        limits: {
          memories: 8,
          decisions: 7,
          tasks: 12,
          reminders: 6,
          goals: 5,
        },
      },
    ]);
  });

  it("uses conservative default context limits and remains closed-world", async () => {
    const { engine } = createSubject();

    await engine.invoke(
      "context_get",
      { asOf: createdAt },
      { principal: { id: accountId } },
    );

    expect(engine.list()).toContainEqual(
      expect.objectContaining({
        id: "context_get",
        description: expect.stringMatching(/knowledge-base catalog/i),
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      }),
    );
  });

  it("creates an idempotent handoff only after editor access is resolved", async () => {
    const { accessRequests, createCalls, engine } = createSubject();

    await expect(
      engine.invoke(
        "handoffs_create",
        {
          title: "  Launch handoff  ",
          summary: "  The release is ready for review.  ",
          nextActions: ["  Review the release notes.  "],
          entityRefs: [{ type: "task", id: taskId }],
          idempotencyKey: "handoff-launch-v1",
        },
        { principal: { id: accountId }, source: "mcp-http" },
      ),
    ).resolves.toEqual(handoff);

    expect(accessRequests.at(-1)).toEqual(
      expect.objectContaining({ requiredRole: "editor" }),
    );
    expect(createCalls).toEqual([
      {
        title: "Launch handoff",
        summary: "The release is ready for review.",
        nextActions: ["Review the release notes."],
        entityRefs: [{ type: "task", id: taskId }],
        expiresAt: null,
        idempotencyKey: "handoff-launch-v1",
      },
    ]);
    expect(engine.list()).toContainEqual(
      expect.objectContaining({
        id: "handoffs_create",
        annotations: {
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      }),
    );
  });

  it("lists handoffs with an opaque cursor and viewer access", async () => {
    const { accessRequests, engine, listCalls } = createSubject();
    const cursor = encodeCursor({ ts: createdAt, id: handoffId });

    await expect(
      engine.invoke(
        "handoffs_list",
        { cursor, limit: 12 },
        { principal: { id: accountId } },
      ),
    ).resolves.toEqual({ items: [handoff], nextCursor: cursor });

    expect(accessRequests.at(-1)).toEqual(
      expect.objectContaining({ requiredRole: "viewer" }),
    );
    expect(listCalls).toEqual([
      { cursor: { ts: createdAt, id: handoffId }, limit: 12 },
    ]);
  });

  it("rejects unbounded or malformed handoff inputs before writing", async () => {
    const { createCalls, engine } = createSubject();

    await expect(
      engine.invoke(
        "handoffs_create",
        {
          title: "Handoff",
          summary: "Summary",
          nextActions: Array.from(
            { length: 21 },
            (_, index) => `Action ${index}`,
          ),
          entityRefs: [],
          idempotencyKey: "handoff-too-many-actions",
        },
        { principal: { id: accountId } },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(createCalls).toEqual([]);
  });

  it("rejects unauthenticated calls before resolving brain access", async () => {
    const { accessRequests, engine } = createSubject();

    await expect(
      engine.invoke("context_get", { asOf: createdAt }),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(engine.invoke("handoffs_list", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(accessRequests).toEqual([]);
  });
});
