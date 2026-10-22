import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createProjectCapabilities } from "../src/capabilities/projects.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  BrainRole,
  Project,
  ProjectStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const principal = { id: accountId, attributes: { clientId: "cursor-client" } };
const now = "2026-08-16T12:00:00.000Z";

const roleRank: Readonly<Record<BrainRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

function attribution(access: BrainAccessContext): ActorAttribution {
  return {
    kind: access.actor.kind,
    accountId: access.actor.accountId,
    clientId: access.actor.clientId,
    source: access.actor.source,
  } as ActorAttribution;
}

class FakeAccessStore implements BrainAccessStore {
  readonly requests: BrainAccessRequest[] = [];
  readonly roles = new Map<string, BrainRole>([[accountId, "owner"]]);

  async resolveAccess(request: BrainAccessRequest): Promise<BrainAccessContext> {
    this.requests.push(request);
    const role = this.roles.get(request.principal.id);
    if (role === undefined || roleRank[role] < roleRank[request.requiredRole]) {
      throw new Error("Brain access was denied.");
    }
    const clientId = request.principal.attributes?.clientId;
    const actor =
      request.source === "mcp_http" && typeof clientId === "string"
        ? {
            kind: "oauth_client" as const,
            accountId: request.principal.id,
            clientId,
            source: request.source,
            requestId: request.requestId,
            correlationId: request.correlationId,
            causationId: null,
            dreamingRunId: null,
          }
        : {
            kind: "account" as const,
            accountId: request.principal.id,
            clientId: null,
            source: request.source,
            requestId: request.requestId,
            correlationId: request.correlationId,
            causationId: null,
            dreamingRunId: null,
          };
    return { accountId: request.principal.id, role, actor };
  }

  async revalidateAccess(
    access: BrainAccessContext,
    requiredRole: BrainRole,
  ): Promise<BrainAccessContext> {
    const role = this.roles.get(access.accountId);
    if (role === undefined || roleRank[role] < roleRank[requiredRole]) {
      throw new Error("Brain access was denied.");
    }
    return { ...access, role };
  }

  async getTimeZone(): Promise<string> {
    return "UTC";
  }
}

class FakeProjectStore implements ProjectStore {
  readonly records = new Map<string, Project>();
  private readonly receipts = new Map<string, Project>();
  private nextId = 1;

  async createProject(
    access: BrainAccessContext,
    input: {
      readonly name: string;
      readonly description: string | null;
      readonly idempotencyKey: string;
    },
  ): Promise<Project> {
    const receiptKey = `create:${input.idempotencyKey}`;
    const receipt = this.receipts.get(receiptKey);
    if (receipt !== undefined) return receipt;
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`;
    const project: Project = {
      id,
      name: input.name,
      description: input.description,
      status: "active",
      version: 1,
      provenance: attribution(access),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, project);
    this.receipts.set(receiptKey, project);
    return project;
  }

  async listProjects(
    access: BrainAccessContext,
    input: Parameters<ProjectStore["listProjects"]>[1],
  ) {
    const items = [...this.records.values()].filter(
      (project) => input.status === null || project.status === input.status,
    );
    return { items: items.slice(0, input.limit), nextCursor: null };
  }

  async updateProject(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<ProjectStore["updateProject"]>[2],
  ): Promise<Project | null> {
    const receiptKey = `update:${changes.precondition.idempotencyKey}`;
    const receipt = this.receipts.get(receiptKey);
    if (receipt !== undefined) return receipt;
    const key = id;
    const current = this.records.get(key);
    if (current === undefined) return null;
    if (current.version !== changes.precondition.expectedVersion) {
      throw new Error("Project version conflict.");
    }
    const updated: Project = {
      ...current,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.description === undefined ? {} : { description: changes.description }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
      version: current.version + 1,
      updatedAt: "2026-08-16T12:01:00.000Z",
    };
    this.records.set(key, updated);
    this.receipts.set(receiptKey, updated);
    return updated;
  }

  async findProjectByName(
    access: BrainAccessContext,
    name: string,
  ): Promise<Project | null> {
    return (
      [...this.records.values()].find(
        (project) => project.name === name,
      ) ?? null
    );
  }
}

function createProjectEngine() {
  const accessStore = new FakeAccessStore();
  const projectStore = new FakeProjectStore();
  const capabilities = createProjectCapabilities(accessStore, projectStore);
  return {
    accessStore,
    projectStore,
    engine: createEngine({ name: "projects-test", version: "1.0.0", capabilities }),
  };
}

describe("project capabilities", () => {
  it("resolves default and explicit brain access with the least required role", async () => {
    const { accessStore, engine } = createProjectEngine();
    await engine.invoke(
      "projects_create",
      {
        name: "Shared launch",
        idempotencyKey: "project-create-shared",
      },
      { principal, requestId: "request-create", source: "mcp-http" },
    );
    await engine.invoke("projects_list", {}, { principal, requestId: "request-list" });

    expect(accessStore.requests).toMatchObject([
      {
        requiredRole: "editor",
        source: "mcp_http",
        requestId: "request-create",
      },
      {
        requiredRole: "viewer",
        source: "direct",
        requestId: "request-list",
      },
    ]);
  });

  it("is idempotent for create and update and enforces optimistic versions", async () => {
    const { projectStore, engine } = createProjectEngine();
    const createInput = { name: "Launch", idempotencyKey: "project-create" };
    const first = await engine.invoke("projects_create", createInput, { principal });
    const replay = await engine.invoke("projects_create", createInput, { principal });
    expect(replay).toEqual(first);
    expect(projectStore.records).toHaveLength(1);

    await expect(
      engine.invoke(
        "projects_update",
        {
          id: first.id,
          name: "Wrong version",
          expectedVersion: 2,
          idempotencyKey: "project-conflict",
        },
        { principal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      cause: expect.objectContaining({ message: "Project version conflict." }),
    });

    const updateInput = {
      id: first.id,
      status: "paused" as const,
      expectedVersion: 1,
      idempotencyKey: "project-update",
    };
    const updated = await engine.invoke("projects_update", updateInput, { principal });
    const updateReplay = await engine.invoke("projects_update", updateInput, { principal });
    expect(updated).toMatchObject({ version: 2, status: "paused" });
    expect(updateReplay).toEqual(updated);
  });

  it("fails closed when the account has no database role and rejects invalid clean-v1 inputs", async () => {
    const { accessStore, engine } = createProjectEngine();
    accessStore.roles.clear();

    await expect(
      engine.invoke(
        "projects_create",
        {
          name: "Denied",
          idempotencyKey: "denied-project",
        },
        { principal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      cause: expect.objectContaining({ message: "Brain access was denied." }),
    });
    await expect(
      engine.invoke(
        "projects_update",
        {
          id: "00000000-0000-4000-8000-000000000030",
          expectedVersion: 1,
          idempotencyKey: "no-project-change",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("publishes UUID, idempotency, pagination, and annotation contracts", () => {
    const { engine } = createProjectEngine();
    expect(engine.list()).toMatchObject([
      {
        id: "projects_create",
        annotations: {
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
      {
        id: "projects_list",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
      {
        id: "projects_update",
        annotations: {
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
    ]);
    const createSchema = engine.describe("projects_create").inputSchema as {
      properties: Record<string, { format?: string }>;
      required: string[];
    };
    expect(createSchema.required).toEqual(
      expect.arrayContaining(["name", "idempotencyKey"]),
    );
    // Discovery must not advertise a brain selector: a client has no way to
    // learn a brain id and the engine serves exactly one.
    expect(createSchema.properties).not.toHaveProperty("brainId");
    expect(createSchema.properties).not.toHaveProperty("ownerId");
    const listOutput = engine.describe("projects_list").outputSchema as {
      properties: Record<string, unknown>;
    };
    expect(listOutput.properties).toHaveProperty("nextCursor");
  });
});
