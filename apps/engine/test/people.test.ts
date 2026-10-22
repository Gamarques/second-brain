import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createPeopleCapabilities } from "../src/capabilities/people.js";
import type {
  ActorAttribution,
  BrainAccessContext,
  BrainAccessRequest,
  BrainAccessStore,
  BrainRole,
  Person,
  PersonStore,
} from "../src/domain.js";

const accountId = "00000000-0000-4000-8000-000000000101";
const principal = { id: accountId };
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
    return {
      accountId: request.principal.id,
      role,
      actor: {
        kind: "account",
        accountId: request.principal.id,
        clientId: null,
        source: request.source,
        requestId: request.requestId,
        correlationId: request.correlationId,
        causationId: null,
        dreamingRunId: null,
      },
    };
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

class FakePersonStore implements PersonStore {
  readonly records = new Map<string, Person>();
  private readonly receipts = new Map<string, Person>();
  private nextId = 1;

  async createPerson(
    access: BrainAccessContext,
    input: Parameters<PersonStore["createPerson"]>[1],
  ): Promise<Person> {
    const receiptKey = `create:${input.idempotencyKey}`;
    const receipt = this.receipts.get(receiptKey);
    if (receipt !== undefined) return receipt;
    const id = `00000000-0000-4000-8001-${String(this.nextId++).padStart(12, "0")}`;
    const person: Person = {
      id,
      name: input.name,
      aliases: [...input.aliases],
      notes: input.notes,
      summary: input.summary,
      tags: [...input.tags],
      projectIds: [...input.projectIds],
      knowledgeBaseIds: [...input.knowledgeBaseIds],
      version: 1,
      provenance: attribution(access),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, person);
    this.receipts.set(receiptKey, person);
    return person;
  }

  async listPeople(
    access: BrainAccessContext,
    input: Parameters<PersonStore["listPeople"]>[1],
  ) {
    const normalizedQuery = input.query?.toLocaleLowerCase() ?? null;
    const items = [...this.records.values()].filter(
      (person) =>
        normalizedQuery === null ||
          person.name.toLocaleLowerCase().includes(normalizedQuery) ||
        person.name.toLocaleLowerCase().includes(normalizedQuery) ||
        person.aliases.some((alias) => alias.toLocaleLowerCase().includes(normalizedQuery)),
    );
    return { items: items.slice(0, input.limit), nextCursor: null };
  }

  async updatePerson(
    access: BrainAccessContext,
    id: string,
    changes: Parameters<PersonStore["updatePerson"]>[2],
  ): Promise<Person | null> {
    const receiptKey = `update:${changes.precondition.idempotencyKey}`;
    const receipt = this.receipts.get(receiptKey);
    if (receipt !== undefined) return receipt;
    const key = id;
    const current = this.records.get(key);
    if (current === undefined) return null;
    if (current.version !== changes.precondition.expectedVersion) {
      throw new Error("Person version conflict.");
    }
    const updated: Person = {
      ...current,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.aliases === undefined ? {} : { aliases: [...changes.aliases] }),
      ...(changes.notes === undefined ? {} : { notes: changes.notes }),
      ...(changes.summary === undefined ? {} : { summary: changes.summary }),
      ...(changes.tags === undefined ? {} : { tags: [...changes.tags] }),
      ...(changes.projectIds === undefined
        ? {}
        : { projectIds: [...changes.projectIds] }),
      ...(changes.knowledgeBaseIds === undefined
        ? {}
        : { knowledgeBaseIds: [...changes.knowledgeBaseIds] }),
      version: current.version + 1,
      updatedAt: "2026-08-16T12:01:00.000Z",
    };
    this.records.set(key, updated);
    this.receipts.set(receiptKey, updated);
    return updated;
  }

  async findPersonByName(
    access: BrainAccessContext,
    name: string,
  ): Promise<Person | null> {
    return (
      [...this.records.values()].find(
        (person) => person.name === name,
      ) ?? null
    );
  }
}

function createPeopleEngine() {
  const accessStore = new FakeAccessStore();
  const personStore = new FakePersonStore();
  const capabilities = createPeopleCapabilities(accessStore, personStore);
  return {
    accessStore,
    personStore,
    engine: createEngine({ name: "people-test", version: "1.0.0", capabilities }),
  };
}

describe("people capabilities", () => {
  it("resolves editor access for writes and viewer access for reads of the one brain", async () => {
    const { accessStore, engine } = createPeopleEngine();
    const person = await engine.invoke(
      "people_create",
      {
        name: "Grace Hopper",
        aliases: ["Amazing Grace"],
        idempotencyKey: "person-shared",
      },
      { principal, requestId: "person-create" },
    );
    const people = await engine.invoke("people_list", {}, { principal });

    expect(person).not.toHaveProperty("brainId");
    expect(people.people).toEqual([person]);
    expect(accessStore.requests.map(({ requiredRole }) => requiredRole)).toEqual([
      "editor",
      "viewer",
    ]);
  });

  it("is idempotent and rejects stale optimistic updates", async () => {
    const { personStore, engine } = createPeopleEngine();
    const createInput = { name: "Alan Kay", idempotencyKey: "person-create" };
    const first = await engine.invoke("people_create", createInput, { principal });
    const replay = await engine.invoke("people_create", createInput, { principal });
    expect(replay).toEqual(first);
    expect(personStore.records).toHaveLength(1);

    await expect(
      engine.invoke(
        "people_update",
        {
          id: first.id,
          notes: "Stale",
          expectedVersion: 8,
          idempotencyKey: "person-conflict",
        },
        { principal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      cause: expect.objectContaining({ message: "Person version conflict." }),
    });

    const updateInput = {
      id: first.id,
      aliases: ["A. Kay"],
      expectedVersion: 1,
      idempotencyKey: "person-update",
    };
    const updated = await engine.invoke("people_update", updateInput, { principal });
    const updateReplay = await engine.invoke("people_update", updateInput, { principal });
    expect(updated).toMatchObject({ aliases: ["A. Kay"], version: 2 });
    expect(updateReplay).toEqual(updated);
  });

  // Cross-brain isolation is a store concern now that no capability input can
  // name a brain; it is covered against PostgreSQL in
  // test/integration/project-person-stores.test.ts.

  it("validates clean-v1 schemas and exposes safe annotations", async () => {
    const { engine } = createPeopleEngine();
    await expect(
      engine.invoke(
        "people_create",
        { name: "Missing idempotency key" } as never,
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(
      engine.invoke(
        "people_update",
        {
          id: "00000000-0000-4000-8000-000000000110",
          expectedVersion: 1,
          idempotencyKey: "person-no-change",
        },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });

    expect(engine.list()).toMatchObject([
      {
        id: "people_create",
        annotations: {
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
      {
        id: "people_list",
        annotations: {
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
      {
        id: "people_update",
        annotations: {
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
    ]);
    const updateSchema = engine.describe("people_update").inputSchema as {
      properties: Record<string, { format?: string }>;
      required: string[];
    };
    expect(updateSchema.required).toEqual(
      expect.arrayContaining(["id", "expectedVersion", "idempotencyKey"]),
    );
    expect(updateSchema.properties).not.toHaveProperty("ownerId");
    // Discovery must not advertise a brain selector: a client has no way to
    // learn a brain id and the engine serves exactly one.
    expect(updateSchema.properties).not.toHaveProperty("brainId");
  });
});
