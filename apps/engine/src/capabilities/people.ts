import { z } from "zod";

import type { BrainAccessStore, Person, PersonStore } from "../domain.js";
import { requireBrainAccess } from "./access.js";
import { defineCapability } from "./define.js";
import {
  cursorSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  idSchema,
  nullableTextSchema,
  personSchema,
  requireFound,
  uniqueIdsSchema,
} from "./schemas.js";

const personNameSchema = z.string().trim().min(1).max(300);
const aliasesSchema = z.array(z.string().trim().min(1).max(300)).max(50);

function writablePerson(person: Person) {
  return {
    ...person,
    aliases: [...person.aliases],
    tags: [...person.tags],
    projectIds: [...person.projectIds],
    knowledgeBaseIds: [...person.knowledgeBaseIds],
  };
}

export function createPeopleCapabilities(
  accessStore: BrainAccessStore,
  personStore: PersonStore,
) {
  const createPerson = defineCapability({
    title: "Create a person",
    description:
      "Records a person in the people index that memories, documents, and decisions can reference. Optional summary, tags, projectIds, and knowledgeBaseIds link the person to related work.",
    input: z.object({
      name: personNameSchema,
      aliases: aliasesSchema.default([]),
      notes: nullableTextSchema.default(null),
      summary: z.string().trim().min(1).max(1_000).nullable().default(null),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      projectIds: uniqueIdsSchema(50).default([]),
      knowledgeBaseIds: uniqueIdsSchema(50).default([]),
      idempotencyKey: idempotencyKeySchema,
    }),
    output: personSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      return writablePerson(
        await personStore.createPerson(
          access,
          {
            name: input.name,
            aliases: input.aliases,
            notes: input.notes,
            summary: input.summary,
            tags: input.tags,
            projectIds: input.projectIds,
            knowledgeBaseIds: input.knowledgeBaseIds,
            idempotencyKey: input.idempotencyKey,
          },
          context.signal,
        ),
      );
    },
  });

  const listPeople = defineCapability({
    title: "List people",
    description:
      "Lists the people index (id, name, aliases, summary, tags, and related project and knowledge-base IDs), optionally filtered by a name or alias substring. For who-is questions, prefer brain_search so knowledge documents are included in the same call.",
    input: z.object({
      query: z.string().trim().min(1).max(300).nullable().default(null),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: cursorSchema.nullable().default(null),
    }),
    output: z.object({
      people: z.array(personSchema),
      nextCursor: cursorSchema.nullable(),
    }),
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "viewer",
      });
      const page = await personStore.listPeople(
        access,
        {
          query: input.query,
          cursor: input.cursor === null ? null : decodeCursor(input.cursor),
          limit: input.limit,
        },
        context.signal,
      );
      return {
        people: page.items.map(writablePerson),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
  });

  const updatePerson = defineCapability({
    title: "Update a person",
    description:
      "Updates a person in the brain using an optimistic version precondition.",
    input: z
      .object({
        id: idSchema,
        expectedVersion: z.number().int().positive(),
        idempotencyKey: idempotencyKeySchema,
        name: personNameSchema.optional(),
        aliases: aliasesSchema.optional(),
        notes: nullableTextSchema.optional(),
        summary: z.string().trim().min(1).max(1_000).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        projectIds: uniqueIdsSchema(50).optional(),
        knowledgeBaseIds: uniqueIdsSchema(50).optional(),
      })
      .refine(
        (value) =>
          value.name !== undefined ||
          value.aliases !== undefined ||
          value.notes !== undefined ||
          value.summary !== undefined ||
          value.tags !== undefined ||
          value.projectIds !== undefined ||
          value.knowledgeBaseIds !== undefined,
        { message: "At least one person change is required." },
      ),
    output: personSchema,
    access: "authenticated",
    timeoutMs: 10_000,
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run({ input, context }) {
      const access = await requireBrainAccess(accessStore, context, {
        requiredRole: "editor",
      });
      const person = requireFound(
        await personStore.updatePerson(
          access,
          input.id,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
            ...(input.projectIds === undefined ? {} : { projectIds: input.projectIds }),
            ...(input.knowledgeBaseIds === undefined
              ? {}
              : { knowledgeBaseIds: input.knowledgeBaseIds }),
            precondition: {
              expectedVersion: input.expectedVersion,
              idempotencyKey: input.idempotencyKey,
            },
          },
          context.signal,
        ),
        "Person",
      );
      return writablePerson(person);
    },
  });

  return {
    people_create: createPerson,
    people_list: listPeople,
    people_update: updatePerson,
  } as const;
}
