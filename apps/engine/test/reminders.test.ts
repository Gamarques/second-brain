import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createReminderCapabilities } from "../src/capabilities/reminders.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  BrainRole,
  Reminder,
  ReminderStore,
  ReminderVersion,
} from "../src/domain.js";

const accountId = "11000000-0000-4000-8000-000000000001";
const reminderId = "31000000-0000-4000-8000-000000000001";
const eventId = "41000000-0000-4000-8000-000000000001";
const versionId = "51000000-0000-4000-8000-000000000001";
const ts = "2026-08-16T12:00:00.000Z";
const principal = { id: accountId };

const attribution: ActorAttribution = {
  kind: "account",
  accountId,
  clientId: null,
  source: "direct",
};

function accessContext(
  role: BrainRole = "owner",
  source: BrainAccessRequest["source"] = "direct",
  requestId = "request-1",
): BrainAccessContext {
  return {
    accountId,
    role,
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source,
      requestId,
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: reminderId,
    message: "Review the launch",
    remindAt: "2026-08-17T09:00:00.000Z",
    completedAt: null,
    version: 1,
    historyCompleteFrom: ts,
    provenance: attribution,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function reminderVersion(overrides: Partial<ReminderVersion> = {}): ReminderVersion {
  const current = reminder();
  return {
    id: versionId,
    reminderId,
    version: 1,
    operation: "created",
    snapshot: {
      id: current.id,
      message: current.message,
      remindAt: current.remindAt,
      completedAt: current.completedAt,
    },
    effectiveAt: ts,
    recordedAt: ts,
    changedFields: ["message"],
    provenance: attribution,
    activityEventId: eventId,
    ...overrides,
  };
}

interface AccessControls {
  readonly requests: BrainAccessRequest[];
}

function createAccessStore(): { readonly store: BrainAccessStore; readonly controls: AccessControls } {
  const controls: AccessControls = { requests: [] };
  const store: BrainAccessStore = {
    async resolveAccess(request) {
      controls.requests.push(request);
      return accessContext(request.requiredRole, request.source, request.requestId);
    },
    async revalidateAccess(access) {
      return access;
    },
    async getTimeZone() {
      return "America/Sao_Paulo";
    },
  };
  return { store, controls };
}

interface ReminderCalls {
  readonly create: Parameters<ReminderStore["createReminder"]>[];
  readonly list: Parameters<ReminderStore["listReminders"]>[];
  readonly update: Parameters<ReminderStore["updateReminder"]>[];
  readonly remove: Parameters<ReminderStore["deleteReminder"]>[];
  readonly history: Parameters<ReminderStore["listReminderHistory"]>[];
}

interface ReminderControls {
  updateResult: Reminder | null;
  deleteResult: boolean;
  readonly createdByKey: Map<string, Reminder>;
}

function createReminderStore(): {
  readonly store: ReminderStore;
  readonly calls: ReminderCalls;
  readonly controls: ReminderControls;
} {
  const calls: ReminderCalls = { create: [], list: [], update: [], remove: [], history: [] };
  const controls: ReminderControls = {
    updateResult: reminder({ version: 2 }),
    deleteResult: true,
    createdByKey: new Map(),
  };
  const store: ReminderStore = {
    async createReminder(...args) {
      calls.create.push(args);
      const key = args[1].idempotencyKey;
      const existing = controls.createdByKey.get(key);
      if (existing !== undefined) return existing;
      const created = reminder({ message: args[1].message, remindAt: args[1].remindAt });
      controls.createdByKey.set(key, created);
      return created;
    },
    async listReminders(...args) {
      calls.list.push(args);
      return {
        items: [reminder()],
        nextCursor: { ts, id: reminderId },
        coverage: {
          completeFrom: "2026-02-01T00:00:00.000Z",
          requestedAsOf: args[1].asOf,
          complete: false,
          warnings: ["Imported history begins in February."],
        },
      };
    },
    async updateReminder(...args) {
      calls.update.push(args);
      return controls.updateResult;
    },
    async deleteReminder(...args) {
      calls.remove.push(args);
      return controls.deleteResult;
    },
    async listReminderHistory(...args) {
      calls.history.push(args);
      return {
        items: [reminderVersion()],
        nextCursor: { ts, id: versionId },
        coverage: {
          completeFrom: ts,
          requestedAsOf: null,
          complete: true,
          warnings: [],
        },
      };
    },
  };
  return { store, calls, controls };
}

function createTestEngine() {
  const access = createAccessStore();
  const reminders = createReminderStore();
  const capabilities = createReminderCapabilities(access.store, reminders.store);
  const engine = createEngine({ name: "reminders-test", version: "1.0.0", capabilities });
  return { engine, access, reminders };
}

function executionFailure(message: string) {
  return { code: "EXECUTION_FAILED", cause: expect.objectContaining({ message }) };
}

describe("v1 reminder capabilities", () => {
  it("does not expose a brain identifier in public schemas", () => {
    const { engine } = createTestEngine();

    const capabilityIds = [
      "reminders_create",
      "reminders_list",
      "reminders_update",
      "reminders_delete",
      "reminders_history_list",
    ] as const;

    for (const capabilityId of capabilityIds) {
      const description = engine.describe(capabilityId);
      expect(JSON.stringify(description.inputSchema)).not.toContain("brainId");
      expect(JSON.stringify(description.outputSchema)).not.toContain("brainId");
    }
  });

  it("publishes explicit annotations and rejects unauthenticated reads", async () => {
    const { engine, access } = createTestEngine();

    expect(engine.describe("reminders_list").annotations).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    expect(engine.describe("reminders_update").annotations).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: true,
    });
    expect(engine.describe("reminders_delete").annotations).toMatchObject({
      readOnly: false,
      destructive: true,
      idempotent: true,
    });
    expect(engine.describe("reminders_delete").description).toContain(
      "the canonical reminder and its version and delivery history",
    );
    expect(engine.describe("reminders_delete").description).toContain(
      "ingestion sources, dreaming reports, or handoffs are not purged",
    );

    await expect(
      engine.invoke("reminders_list", {}, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(access.controls.requests).toHaveLength(0);
  });

  it("uses viewer, editor, and admin access for reads, writes, and privacy deletes", async () => {
    const { engine, access } = createTestEngine();

    await engine.invoke("reminders_list", {}, { principal });
    await engine.invoke(
      "reminders_create",
      {
        message: "Review",
        remindAt: ts,
        idempotencyKey: "create-1",
      },
      { principal },
    );
    await engine.invoke(
      "reminders_delete",
      { id: reminderId, idempotencyKey: "delete-1" },
      { principal },
    );

    expect(access.controls.requests.map(({ requiredRole }) => requiredRole)).toEqual([
      "viewer",
      "editor",
      "admin",
    ]);
    expect(
      access.controls.requests.every((request) => request.principal.id === principal.id),
    ).toBe(true);
  });

  it("preserves offset timestamps and delegates replay-safe creation to the store", async () => {
    const { engine, reminders } = createTestEngine();
    const remindAt = "2026-08-18T08:15:00+05:30";
    const input = { message: "Call Ada", remindAt, idempotencyKey: "same-reminder" };

    const first = await engine.invoke("reminders_create", input, { principal });
    const replay = await engine.invoke("reminders_create", input, { principal });

    expect(replay).toEqual(first);
    expect(reminders.calls.create).toHaveLength(2);
    expect(reminders.calls.create[0]![1]).toEqual(input);
  });

  it("passes as-of and cursor pagination through and surfaces incomplete coverage", async () => {
    const { engine, reminders } = createTestEngine();
    const asOf = "2026-08-16T08:45:00-03:00";

    const first = await engine.invoke(
      "reminders_list",
      { includeCompleted: true, asOf, limit: 1 },
      { principal },
    );
    expect(first).toMatchObject({
      reminders: [{ id: reminderId }],
      nextCursor: expect.any(String),
      coverage: {
        complete: false,
        requestedAsOf: asOf,
        warnings: ["Imported history begins in February."],
      },
    });

    await engine.invoke(
      "reminders_list",
      { asOf, cursor: first.nextCursor },
      { principal },
    );
    expect(reminders.calls.list[1]![1]).toMatchObject({
      asOf,
      cursor: { ts, id: reminderId },
    });
  });

  it("uses one optimistic update contract for completion and reopen", async () => {
    const { engine, reminders } = createTestEngine();
    reminders.controls.updateResult = reminder({ completedAt: ts, version: 2 });

    await expect(
      engine.invoke(
        "reminders_update",
        { id: reminderId, completed: true, expectedVersion: 1, idempotencyKey: "complete-1" },
        { principal },
      ),
    ).resolves.toMatchObject({ completedAt: ts, version: 2 });
    expect(reminders.calls.update[0]![2]).toEqual({
      completed: true,
      precondition: { expectedVersion: 1, idempotencyKey: "complete-1" },
    });

    reminders.controls.updateResult = reminder({ completedAt: null, version: 3 });
    await engine.invoke(
      "reminders_update",
      { id: reminderId, completed: false, expectedVersion: 2, idempotencyKey: "reopen-1" },
      { principal },
    );
    expect(reminders.calls.update[1]![2]).toEqual({
      completed: false,
      precondition: { expectedVersion: 2, idempotencyKey: "reopen-1" },
    });
  });

  it("fails closed for stale and missing reminders through one atomic store call", async () => {
    const { engine, reminders } = createTestEngine();
    reminders.controls.updateResult = null;

    await expect(
      engine.invoke(
        "reminders_update",
        {
          id: reminderId,
          message: "Stale edit",
          expectedVersion: 42,
          idempotencyKey: "stale-1",
        },
        { principal },
      ),
    ).rejects.toMatchObject(
      executionFailure("Reminder was not found or changed after the expected version."),
    );
    expect(reminders.calls.update).toHaveLength(1);
  });

  it("returns paginated reminder history with coverage and validates ranges", async () => {
    const { engine, reminders } = createTestEngine();
    const from = "2026-08-16T08:00:00-03:00";
    const to = "2026-08-16T13:00:00+00:00";

    const page = await engine.invoke(
      "reminders_history_list",
      { reminderId, from, to, limit: 1 },
      { principal },
    );
    expect(page).toMatchObject({
      versions: [{ id: versionId, operation: "created" }],
      nextCursor: expect.any(String),
      coverage: { complete: true, completeFrom: ts },
    });
    expect(reminders.calls.history[0]![1]).toMatchObject({ reminderId, from, to, limit: 1 });

    await expect(
      engine.invoke(
        "reminders_history_list",
        {
          reminderId,
          from: "2026-08-18T00:00:00.000Z",
          to: "2026-08-17T00:00:00.000Z",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("makes privacy deletion idempotent and explicitly destructive", async () => {
    const { engine, reminders } = createTestEngine();

    await expect(
      engine.invoke(
        "reminders_delete",
        { id: reminderId, idempotencyKey: "privacy-delete" },
        { principal },
      ),
    ).resolves.toEqual({ deleted: true });
    expect(reminders.calls.remove[0]![2]).toEqual({ idempotencyKey: "privacy-delete" });

    reminders.controls.deleteResult = false;
    await expect(
      engine.invoke(
        "reminders_delete",
        { id: reminderId, idempotencyKey: "missing-delete" },
        { principal },
      ),
    ).rejects.toMatchObject(executionFailure("Reminder was not found."));
  });
});
