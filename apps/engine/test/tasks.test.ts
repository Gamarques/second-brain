import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createTaskCapabilities } from "../src/capabilities/tasks.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  BrainRole,
  Task,
  TaskList,
  TaskRelation,
  TaskStore,
  TaskVersion,
} from "../src/domain.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const listId = "30000000-0000-4000-8000-000000000001";
const taskId = "40000000-0000-4000-8000-000000000001";
const otherTaskId = "40000000-0000-4000-8000-000000000002";
const projectId = "45000000-0000-4000-8000-000000000001";
const goalId = "50000000-0000-4000-8000-000000000001";
const eventId = "60000000-0000-4000-8000-000000000001";
const versionId = "70000000-0000-4000-8000-000000000001";
const relationId = "80000000-0000-4000-8000-000000000001";
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

function taskList(overrides: Partial<TaskList> = {}): TaskList {
  return {
    id: listId,
    name: "Work",
    description: null,
    provenance: attribution,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    listId,
    title: "Ship v1",
    description: null,
    status: "todo",
    priority: "normal",
    dueAt: null,
    completedAt: null,
    projectId,
    goalLinks: [],
    version: 1,
    historyCompleteFrom: ts,
    provenance: attribution,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function taskVersion(overrides: Partial<TaskVersion> = {}): TaskVersion {
  const current = task();
  return {
    id: versionId,
    taskId,
    version: 1,
    operation: "created",
    snapshot: {
      id: current.id,
      listId: current.listId,
      title: current.title,
      description: current.description,
      status: current.status,
      priority: current.priority,
      dueAt: current.dueAt,
      completedAt: current.completedAt,
      projectId: current.projectId,
      goalLinks: current.goalLinks,
    },
    goalLinks: [],
    effectiveAt: ts,
    recordedAt: ts,
    changedFields: ["title"],
    provenance: attribution,
    activityEventId: eventId,
    ...overrides,
  };
}

interface AccessControls {
  readonly requests: BrainAccessRequest[];
  deny: boolean;
}

function createAccessStore(): { readonly store: BrainAccessStore; readonly controls: AccessControls } {
  const controls: AccessControls = { requests: [], deny: false };
  const store: BrainAccessStore = {
    async resolveAccess(request) {
      controls.requests.push(request);
      if (controls.deny) {
        throw new Error("Brain access was denied.");
      }
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

interface TaskCalls {
  readonly createList: Parameters<TaskStore["createTaskList"]>[];
  readonly create: Parameters<TaskStore["createTask"]>[];
  readonly list: Parameters<TaskStore["listTasks"]>[];
  readonly update: Parameters<TaskStore["updateTask"]>[];
  readonly remove: Parameters<TaskStore["deleteTask"]>[];
  readonly history: Parameters<TaskStore["listTaskHistory"]>[];
  readonly relation: Parameters<TaskStore["createTaskRelation"]>[];
}

interface TaskControls {
  createResult: Task | null;
  updateResult: Task | null;
  deleteResult: boolean;
  readonly createdListsByKey: Map<string, TaskList>;
}

function createTaskStore(): {
  readonly store: TaskStore;
  readonly calls: TaskCalls;
  readonly controls: TaskControls;
} {
  const calls: TaskCalls = {
    createList: [],
    create: [],
    list: [],
    update: [],
    remove: [],
    history: [],
    relation: [],
  };
  const controls: TaskControls = {
    createResult: task(),
    updateResult: task({ version: 2 }),
    deleteResult: true,
    createdListsByKey: new Map(),
  };
  const store: TaskStore = {
    async createTaskList(...args) {
      calls.createList.push(args);
      const key = args[1].idempotencyKey;
      const existing = controls.createdListsByKey.get(key);
      if (existing !== undefined) return existing;
      const created = taskList();
      controls.createdListsByKey.set(key, created);
      return created;
    },
    async listTaskLists() {
      return [taskList()];
    },
    async createTask(...args) {
      calls.create.push(args);
      return controls.createResult;
    },
    async listTasks(...args) {
      calls.list.push(args);
      return {
        items: [task()],
        nextCursor: { ts, id: taskId },
        coverage: {
          completeFrom: "2026-01-01T00:00:00.000Z",
          requestedAsOf: args[1].asOf,
          complete: false,
          warnings: ["History before 2026 is unavailable."],
        },
      };
    },
    async updateTask(...args) {
      calls.update.push(args);
      return controls.updateResult;
    },
    async deleteTask(...args) {
      calls.remove.push(args);
      return controls.deleteResult;
    },
    async listTaskHistory(...args) {
      calls.history.push(args);
      return {
        items: [taskVersion()],
        nextCursor: { ts, id: versionId },
        coverage: {
          completeFrom: ts,
          requestedAsOf: null,
          complete: true,
          warnings: [],
        },
      };
    },
    async createTaskRelation(...args) {
      calls.relation.push(args);
      const relation: TaskRelation = {
        id: relationId,
        fromTaskId: args[1].fromTaskId,
        toTaskId: args[1].toTaskId,
        kind: args[1].kind,
        provenance: attribution,
        createdAt: ts,
        retractedAt: null,
      };
      return relation;
    },
  };
  return { store, calls, controls };
}

function createTestEngine() {
  const access = createAccessStore();
  const tasks = createTaskStore();
  const capabilities = createTaskCapabilities(access.store, tasks.store);
  const engine = createEngine({ name: "tasks-test", version: "1.0.0", capabilities });
  return { engine, capabilities, access, tasks };
}

function executionFailure(message: string) {
  return { code: "EXECUTION_FAILED", cause: expect.objectContaining({ message }) };
}

describe("v1 task capabilities", () => {
  it("does not expose a brain identifier in public schemas", () => {
    const { engine } = createTestEngine();

    const capabilityIds = [
      "task_lists_create",
      "task_lists_list",
      "tasks_create",
      "tasks_list",
      "tasks_update",
      "tasks_delete",
      "tasks_history_list",
      "task_relations_create",
    ] as const;

    for (const capabilityId of capabilityIds) {
      const description = engine.describe(capabilityId);
      expect(JSON.stringify(description.inputSchema)).not.toContain("brainId");
      expect(JSON.stringify(description.outputSchema)).not.toContain("brainId");
    }
  });

  it("publishes explicit annotations and rejects unauthenticated calls before store access", async () => {
    const { engine, access } = createTestEngine();

    expect(engine.describe("tasks_list").annotations).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    expect(engine.describe("tasks_update").annotations).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: true,
    });
    expect(engine.describe("tasks_delete").annotations).toMatchObject({
      readOnly: false,
      destructive: true,
      idempotent: true,
    });
    expect(engine.describe("tasks_delete").description).toContain(
      "the canonical task and its version and relationship history",
    );
    expect(engine.describe("tasks_delete").description).toContain(
      "ingestion sources, dreaming reports, or handoffs are not purged",
    );

    await expect(engine.invoke("tasks_list", {}, { principal: null })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(access.controls.requests).toHaveLength(0);
  });

  it("resolves account access with the minimum required role", async () => {
    const { engine, access } = createTestEngine();

    await engine.invoke("tasks_list", {}, { principal, requestId: "read-request" });
    await engine.invoke(
      "task_lists_create",
      { name: "Work", idempotencyKey: "list-1" },
      { principal, requestId: "write-request", source: "mcp-http" },
    );
    await engine.invoke(
      "tasks_delete",
      { id: taskId, idempotencyKey: "delete-1" },
      { principal },
    );

    expect(access.controls.requests.map(({ requiredRole, source, requestId }) => ({
      requiredRole,
      source,
      requestId,
    }))).toEqual([
      { requiredRole: "viewer", source: "direct", requestId: "read-request" },
      { requiredRole: "editor", source: "mcp_http", requestId: "write-request" },
      { requiredRole: "admin", source: "direct", requestId: expect.any(String) },
    ]);
    expect(
      access.controls.requests.every(({ principal: requested }) => requested.id === principal.id),
    ).toBe(true);
  });

  it("rejects a removed brain id before authorizing reads or writes", async () => {
    const { engine, access } = createTestEngine();
    // No capability declares brainId, so the cast stands in for an untyped MCP
    // client that still sends one.
    const strayBrainId = { brainId: "20000000-0000-4000-8000-000000000002" };

    await expect(
      engine.invoke("tasks_list", strayBrainId as never, { principal }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "task_lists_create",
        {
          name: "Stale client write",
          idempotencyKey: "stale-client-write",
          ...strayBrainId,
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    expect(access.controls.requests).toHaveLength(0);
  });

  it("delegates list creation idempotency atomically to the store", async () => {
    const { engine, tasks } = createTestEngine();
    const input = { name: "Work", description: "Launch", idempotencyKey: "same-key" };

    const first = await engine.invoke("task_lists_create", input, { principal });
    const replay = await engine.invoke("task_lists_create", input, { principal });

    expect(replay).toEqual(first);
    expect(tasks.calls.createList).toHaveLength(2);
    expect(tasks.calls.createList[0]![1]).toEqual({
      name: "Work",
      description: "Launch",
      idempotencyKey: "same-key",
    });
  });

  it("accepts a 200-character task-list name and rejects 201 characters", async () => {
    const { engine, tasks } = createTestEngine();
    const maximumName = "a".repeat(200);

    await engine.invoke(
      "task_lists_create",
      { name: maximumName, idempotencyKey: "name-200" },
      { principal },
    );
    expect(tasks.calls.createList[0]![1].name).toBe(maximumName);

    await expect(
      engine.invoke(
        "task_lists_create",
        { name: "a".repeat(201), idempotencyKey: "name-201" },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(tasks.calls.createList).toHaveLength(1);
  });

  it("creates tasks with offset timestamps and explicit goal links", async () => {
    const { engine, tasks } = createTestEngine();
    const dueAt = "2026-08-17T09:30:00+05:30";

    await engine.invoke(
      "tasks_create",
      {
        listId,
        title: "Ship v1",
        dueAt,
        goalIds: [goalId],
        idempotencyKey: "task-1",
      },
      { principal },
    );

    expect(tasks.calls.create).toHaveLength(1);
    expect(tasks.calls.create[0]![1]).toMatchObject({
      listId,
      projectId: null,
      dueAt,
      goalLinks: [{ goalId, basis: "explicit", confidence: null }],
      idempotencyKey: "task-1",
    });

    tasks.controls.createResult = null;
    await expect(
      engine.invoke(
        "tasks_create",
        { listId, title: "Missing link", idempotencyKey: "task-2" },
        { principal },
      ),
    ).rejects.toMatchObject(executionFailure("A linked task list, project, or goal was not found."));
  });

  it("passes temporal filters and cursors through and returns honest coverage", async () => {
    const { engine, tasks } = createTestEngine();
    const asOf = "2026-08-16T18:45:00-03:00";

    const first = await engine.invoke(
      "tasks_list",
      { status: "todo", goalId, asOf, limit: 1 },
      { principal },
    );
    expect(first).toMatchObject({
      tasks: [{ id: taskId }],
      nextCursor: expect.any(String),
      coverage: {
        complete: false,
        requestedAsOf: asOf,
        warnings: ["History before 2026 is unavailable."],
      },
    });

    await engine.invoke("tasks_list", { cursor: first.nextCursor, asOf }, { principal });
    expect(tasks.calls.list[1]![1].cursor).toEqual({ ts, id: taskId });
    expect(tasks.calls.list[1]![1].asOf).toBe(asOf);
  });

  it("uses one versioned update contract for completion and reopen", async () => {
    const { engine, tasks } = createTestEngine();
    tasks.controls.updateResult = task({ status: "done", completedAt: ts, version: 2 });

    await expect(
      engine.invoke(
        "tasks_update",
        { id: taskId, status: "done", expectedVersion: 1, idempotencyKey: "complete-1" },
        { principal },
      ),
    ).resolves.toMatchObject({ status: "done", version: 2 });
    expect(tasks.calls.update).toHaveLength(1);
    expect(tasks.calls.update[0]![2]).toEqual({
      status: "done",
      precondition: { expectedVersion: 1, idempotencyKey: "complete-1" },
    });

    tasks.controls.updateResult = task({ status: "todo", completedAt: null, version: 3 });
    await engine.invoke(
      "tasks_update",
      { id: taskId, status: "todo", expectedVersion: 2, idempotencyKey: "reopen-1" },
      { principal },
    );
    expect(tasks.calls.update[1]![2]).toMatchObject({
      status: "todo",
      precondition: { expectedVersion: 2, idempotencyKey: "reopen-1" },
    });
  });

  it("distinguishes an omitted project link from an explicit detach", async () => {
    const { engine, tasks } = createTestEngine();

    await engine.invoke(
      "tasks_update",
      { id: taskId, title: "Preserve project", expectedVersion: 1, idempotencyKey: "preserve" },
      { principal },
    );
    expect(tasks.calls.update[0]![2]).not.toHaveProperty("projectId");

    await engine.invoke(
      "tasks_update",
      {
        id: taskId,
        projectId: null,
        expectedVersion: 2,
        idempotencyKey: "detach",
      },
      { principal },
    );
    expect(tasks.calls.update[1]![2]).toMatchObject({ projectId: null });
  });

  it("fails closed for both stale versions and missing tasks without a preflight read", async () => {
    const { engine, tasks } = createTestEngine();
    tasks.controls.updateResult = null;

    await expect(
      engine.invoke(
        "tasks_update",
        { id: taskId, title: "Changed", expectedVersion: 99, idempotencyKey: "stale-1" },
        { principal },
      ),
    ).rejects.toMatchObject(
      executionFailure("Task was not found or changed after the expected version."),
    );
    expect(tasks.calls.update).toHaveLength(1);
  });

  it("exposes immutable history with pagination and validates chronological ranges", async () => {
    const { engine, tasks } = createTestEngine();
    const from = "2026-08-16T09:00:00-03:00";
    const to = "2026-08-16T13:00:00+00:00";

    const page = await engine.invoke(
      "tasks_history_list",
      { taskId, from, to, limit: 1 },
      { principal },
    );
    expect(page).toMatchObject({
      versions: [{ id: versionId, operation: "created" }],
      nextCursor: expect.any(String),
      coverage: { complete: true, completeFrom: ts },
    });
    expect(tasks.calls.history[0]![1]).toMatchObject({ taskId, from, to, limit: 1 });

    await expect(
      engine.invoke(
        "tasks_history_list",
        { taskId, from: "2026-08-17T00:00:00.000Z", to: "2026-08-16T00:00:00.000Z" },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("creates task relations and keeps privacy deletion explicitly destructive", async () => {
    const { engine, tasks } = createTestEngine();

    await expect(
      engine.invoke(
        "task_relations_create",
        {
          fromTaskId: taskId,
          toTaskId: otherTaskId,
          kind: "duplicate_of",
          idempotencyKey: "relation-1",
        },
        { principal },
      ),
    ).resolves.toMatchObject({ kind: "duplicate_of", fromTaskId: taskId, toTaskId: otherTaskId });
    expect(tasks.calls.relation[0]![1].idempotencyKey).toBe("relation-1");

    await expect(
      engine.invoke(
        "task_relations_create",
        { fromTaskId: taskId, toTaskId: taskId, kind: "blocks", idempotencyKey: "self" },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    await expect(
      engine.invoke("tasks_delete", { id: taskId, idempotencyKey: "privacy-delete" }, { principal }),
    ).resolves.toEqual({ deleted: true });
    expect(tasks.calls.remove[0]![2]).toEqual({ idempotencyKey: "privacy-delete" });
  });
});
