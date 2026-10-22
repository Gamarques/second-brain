import { createEngine } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import { createDecisionCapabilities } from "../src/capabilities/decisions.js";
import {
  DECISION_EMBEDDING_RECIPE_VERSION,
  decisionEmbeddingRecipe,
} from "../src/domain.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  Decision,
  DecisionStore,
  DecisionWriteInput,
  EmbeddingProvider,
  EmbeddingSpace,
  EmbeddingSpaceStore,
} from "../src/domain.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const decisionId = "10000000-0000-4000-8000-000000000004";
const replacementId = "10000000-0000-4000-8000-000000000005";
const lineageId = "10000000-0000-4000-8000-000000000006";
const projectId = "10000000-0000-4000-8000-000000000007";
const personId = "10000000-0000-4000-8000-000000000008";
const spaceId = "10000000-0000-4000-8000-000000000009";
const principal = { id: accountId };

const activeSpace: EmbeddingSpace = {
  id: spaceId,
  entityType: "decision",
  provider: "fake",
  model: "fake-embedding-v1",
  modelRevision: "2026-08-01",
  recipeVersion: DECISION_EMBEDDING_RECIPE_VERSION,
  dimensions: 3,
  metric: "cosine",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  promotedAt: "2026-08-01T00:00:01.000Z",
  retiredAt: null,
};

function actor(request: BrainAccessRequest): BrainAccessContext["actor"] {
  return {
    kind: "account" as const,
    accountId: request.principal.id,
    clientId: null,
    source: request.source,
    requestId: request.requestId,
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  };
}

function makeDecision(
  input: DecisionWriteInput,
  overrides: Partial<Decision> = {},
): Decision {
  const replacement = input.supersedesId !== null;
  const timestamp = replacement
    ? "2026-08-16T11:00:01.000Z"
    : "2026-08-16T11:00:00.000Z";
  return {
    id: replacement ? replacementId : decisionId,
    lineageId,
    version: replacement ? 2 : 1,
    supersedesId: input.supersedesId,
    statement: input.statement,
    rationale: input.rationale,
    rejectedAlternatives: input.rejectedAlternatives,
    status: "active",
    projectId: input.projectId,
    personIds: input.personIds,
    decidedAt: input.decidedAt,
    revokedAt: null,
    provenance: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
    },
    sourceExcerpt: input.sourceExcerpt,
    contentHash: input.embedding.contentHash,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createHarness(space: EmbeddingSpace | null = activeSpace) {
  const accessRequests: BrainAccessRequest[] = [];
  const access: BrainAccessStore = {
    resolveAccess: vi.fn(async (request: BrainAccessRequest) => {
      accessRequests.push(request);
      return {
        accountId: request.principal.id,
        role: "owner" as const,
        actor: actor(request),
      };
    }),
    revalidateAccess: vi.fn(async (value) => value),
    getTimeZone: vi.fn(async () => {
      throw new Error("Not used by decision capabilities.");
    }),
  };

  const writes: Array<{
    readonly input: DecisionWriteInput;
  }> = [];
  const decisions: DecisionStore = {
    createDecision: vi.fn(async (_resolvedAccess, input) => {
      writes.push({ input });
      return makeDecision(input);
    }),
    listDecisions: vi.fn(async () => ({ items: [], nextCursor: null })),
    revokeDecision: vi.fn(async (_resolvedAccess, id, precondition) => ({
      ...makeDecision({
        statement: "Use PostgreSQL",
        rationale: "Durability",
        rejectedAlternatives: [],
        projectId: null,
        personIds: [],
        decidedAt: "2026-08-10T00:00:00.000Z",
        sourceExcerpt: null,
        supersedesId: null,
        expectedSupersededHash: null,
        expectedSupersededVersion: null,
        embedding: { spaceId, contentHash: "a".repeat(64), vector: [0, 1, 0] },
        idempotencyKey: precondition.idempotencyKey,
      }),
      id,
      status: "revoked" as const,
      version: precondition.expectedVersion + 1,
      revokedAt: "2026-08-16T11:30:00.000Z",
      updatedAt: "2026-08-16T11:30:00.000Z",
    })),
  };
  const embeddingSpaces: EmbeddingSpaceStore = {
    getActiveSpace: vi.fn(async (_resolvedAccess, entityType) =>
      space === null || entityType !== "decision"
        ? null
        : { ...space },
    ),
    createSpace: vi.fn(async () => {
      throw new Error("Not used by decision capabilities.");
    }),
    promoteSpace: vi.fn(async () => {
      throw new Error("Not used by decision capabilities.");
    }),
  };
  const embedded: Array<{
    readonly texts: readonly string[];
    readonly inputType: "search_document" | "search_query";
  }> = [];
  const embeddings: EmbeddingProvider = {
    provider: "fake",
    model: "fake-embedding-v1",
    modelRevision: "2026-08-01",
    dimensions: 3,
    embed: vi.fn(async (texts, _signal, inputType) => {
      embedded.push({ texts, inputType });
      return texts.map(() => [0, 1, 0]);
    }),
  };
  const capabilities = createDecisionCapabilities(
    access,
    decisions,
    embeddingSpaces,
    embeddings,
  );
  const engine = createEngine({ name: "test", version: "1.0.0", capabilities });
  return { accessRequests, decisions, embedded, engine, writes };
}

function executionError(message: string) {
  return {
    code: "EXECUTION_FAILED",
    cause: expect.objectContaining({ message }),
  };
}

describe("decision capability contracts", () => {
  it("uses editor access for writes and viewer access for historical reads", async () => {
    const { accessRequests, engine } = createHarness();

    await engine.invoke(
      "decisions_create",
      {
        statement: "Use PostgreSQL",
        rationale: "Durability",
        idempotencyKey: "decision-create-1",
      },
      { principal },
    );
    await engine.invoke("decisions_list", {}, { principal });
    await engine.invoke(
      "decisions_revoke",
      {
        id: decisionId,
        expectedVersion: 1,
        idempotencyKey: "decision-revoke-1",
      },
      { principal },
    );

    expect(accessRequests.map(({ requiredRole }) => requiredRole)).toEqual([
      "editor",
      "viewer",
      "editor",
    ]);
  });

  it("marks replay-safe writes as idempotent", () => {
    const { engine } = createHarness();

    expect(engine.describe("decisions_create").annotations?.idempotent).toBe(
      true,
    );
    expect(engine.describe("decisions_revoke").annotations?.idempotent).toBe(
      true,
    );
  });
});

describe("decisions_create", () => {
  it("records a tagged decision embedding, temporal fact, links, and idempotency", async () => {
    const { embedded, engine, writes } = createHarness();

    const result = await engine.invoke(
      "decisions_create",
      {
        statement: "Use PostgreSQL",
        rationale: "It is durable.",
        rejectedAlternatives: [
          { option: "MongoDB", reason: "Relational integrity" },
        ],
        projectId,
        personIds: [personId],
        decidedAt: "2026-08-01T10:00:00.000Z",
        idempotencyKey: "decision-create-2",
      },
      { principal },
    );

    expect(result).toMatchObject({
      statement: "Use PostgreSQL",
      decidedAt: "2026-08-01T10:00:00.000Z",
      projectId,
      personIds: [personId],
    });
    expect(embedded).toEqual([
      {
        texts: [
          decisionEmbeddingRecipe({
            statement: "Use PostgreSQL",
            rationale: "It is durable.",
            rejectedAlternatives: [
              { option: "MongoDB", reason: "Relational integrity" },
            ],
          }).text,
        ],
        inputType: "search_document",
      },
    ]);
    expect(writes[0]?.input).toMatchObject({
      supersedesId: null,
      expectedSupersededHash: null,
      expectedSupersededVersion: null,
      idempotencyKey: "decision-create-2",
      embedding: {
        spaceId,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        vector: [0, 1, 0],
      },
    });
  });

  it("requires all atomic preconditions for explicit supersession", async () => {
    const { engine } = createHarness();

    await expect(
      engine.invoke(
        "decisions_create",
        {
          statement: "Use PostgreSQL",
          rationale: "Durability",
          supersedes: decisionId,
          idempotencyKey: "incomplete-precondition",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    await expect(
      engine.invoke(
        "decisions_create",
        {
          statement: "Use PostgreSQL",
          rationale: "Durability",
          expectedSupersededVersion: 1,
          expectedSupersededHash: "a".repeat(64),
          idempotencyKey: "missing-target",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("creates general information when projectId is omitted", async () => {
    const { engine, writes } = createHarness();

    await expect(
      engine.invoke(
        "decisions_create",
        {
          statement: "Keep one deployment-wide brain",
          rationale: "The deployment is single-tenant.",
          idempotencyKey: "decision-general",
        },
        { principal },
      ),
    ).resolves.toMatchObject({ projectId: null });
    expect(writes[0]?.input.projectId).toBeNull();
  });

  it("forwards a reviewed supersession target with hash and version", async () => {
    const { engine, writes } = createHarness();

    await expect(
      engine.invoke(
        "decisions_create",
        {
          statement: "Use PostgreSQL",
          rationale: "We now require vector search.",
          supersedes: decisionId,
          expectedSupersededVersion: 1,
          expectedSupersededHash: "a".repeat(64),
          idempotencyKey: "decision-supersede-1",
        },
        { principal },
      ),
    ).resolves.toMatchObject({
      id: replacementId,
      supersedesId: decisionId,
      version: 2,
      status: "active",
    });
    expect(writes[0]?.input).toMatchObject({
      supersedesId: decisionId,
      expectedSupersededVersion: 1,
      expectedSupersededHash: "a".repeat(64),
    });
  });

  it("fails before provider transmission when no matching active decision space exists", async () => {
    const { embedded, engine } = createHarness(null);

    await expect(
      engine.invoke(
        "decisions_create",
        {
          statement: "Use PostgreSQL",
          rationale: "Durability",
          idempotencyKey: "missing-space",
        },
        { principal },
      ),
    ).rejects.toMatchObject(
      executionError(
        "The active decision embedding space does not match the provider.",
      ),
    );
    expect(embedded).toEqual([]);
  });
});

describe("decision temporal reads and revocation", () => {
  it("passes as-of, status, context, and cursor filters to the single-brain store", async () => {
    const { decisions, engine } = createHarness();
    const cursorPosition = { ts: "2026-08-01T10:00:00.000Z", id: decisionId };
    vi.mocked(decisions.listDecisions).mockResolvedValueOnce({
      items: [],
      nextCursor: cursorPosition,
    });

    const first = await engine.invoke(
      "decisions_list",
      {
        status: "revoked",
        projectId,
        personId,
        asOf: "2026-08-15T00:00:00.000Z",
        includeSuperseded: true,
      },
      { principal },
    );
    expect(first.nextCursor).toEqual(expect.any(String));

    await engine.invoke(
      "decisions_list",
      { cursor: first.nextCursor },
      { principal },
    );
    expect(decisions.listDecisions).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId }),
      expect.objectContaining({ cursor: cursorPosition }),
      expect.any(AbortSignal),
    );
    expect(decisions.listDecisions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId }),
      expect.objectContaining({
        status: "revoked",
        projectId,
        personId,
        asOf: "2026-08-15T00:00:00.000Z",
        includeSuperseded: true,
      }),
      expect.any(AbortSignal),
    );
  });

  it("revokes with optimistic version and idempotency preconditions", async () => {
    const { decisions, engine } = createHarness();

    const result = await engine.invoke(
      "decisions_revoke",
      { id: decisionId, expectedVersion: 1, idempotencyKey: "revoke-2" },
      { principal },
    );

    expect(result).toMatchObject({
      id: decisionId,
      version: 2,
      status: "revoked",
      revokedAt: "2026-08-16T11:30:00.000Z",
    });
    expect(decisions.revokeDecision).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
      decisionId,
      { expectedVersion: 1, idempotencyKey: "revoke-2" },
      expect.any(AbortSignal),
    );
  });

  it("fails closed for missing, foreign, already superseded, or already revoked targets", async () => {
    const { decisions, engine } = createHarness();
    vi.mocked(decisions.revokeDecision).mockResolvedValueOnce(null);

    await expect(
      engine.invoke(
        "decisions_revoke",
        {
          id: decisionId,
          expectedVersion: 1,
          idempotencyKey: "revoke-missing",
        },
        { principal },
      ),
    ).rejects.toMatchObject(
      executionError(
        "Decision was not found, is not active, or its version is stale.",
      ),
    );
  });
});
