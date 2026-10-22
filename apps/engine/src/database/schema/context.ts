import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import {
  actorKindEnum,
  actorAttributionCheck,
  createdAtColumn,
  idColumn,
  instantColumn,
  mutationSourceEnum,
} from "./common.js";
import { accounts } from "./identity.js";

export const brainHandoffs = pgTable(
  "brain_handoffs",
  {
    id: idColumn(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    nextActions: text("next_actions").array().notNull().default([]),
    entityRefs: jsonb("entity_refs").notNull().default([]),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    actorClientId: text("actor_client_id"),
    actorSource: mutationSourceEnum("actor_source").notNull(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    dreamingRunId: uuid("dreaming_run_id"),
    createdAt: createdAtColumn(),
    expiresAt: instantColumn("expires_at"),
  },
  (table) => [
    index("brain_handoffs_created_idx").on(table.createdAt, table.id),
    check(
      "brain_handoffs_title_check",
      sql`length(btrim(${table.title})) between 1 and 300`,
    ),
    check(
      "brain_handoffs_summary_check",
      sql`length(btrim(${table.summary})) between 1 and 5000`,
    ),
    check(
      "brain_handoffs_entity_refs_check",
      sql`jsonb_typeof(${table.entityRefs}) = 'array'`,
    ),
    actorAttributionCheck("brain_handoffs_actor_check", table),
  ],
);

export type BrainHandoffRow = typeof brainHandoffs.$inferSelect;
