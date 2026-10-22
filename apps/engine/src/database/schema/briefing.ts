import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn } from "./common.js";
import { dreamingReports } from "./dreaming.js";
import { accounts } from "./identity.js";
export const briefingActions = pgTable(
  "briefing_actions",
  {
    id: idColumn(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => dreamingReports.id, { onDelete: "cascade" }),
    insightIndex: integer("insight_index").notNull(),
    kind: text("kind").$type<"task" | "reminder" | "resolve">().notNull(),
    inputDigest: text("input_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    entityId: uuid("entity_id"),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    requestId: text("request_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("briefing_actions_insight_kind_key").on(
      table.reportId,
      table.insightIndex,
      table.kind,
    ),
    index("briefing_actions_created_idx").on(table.createdAt, table.id),
    check(
      "briefing_actions_index_check",
      sql`${table.insightIndex} between 0 and 9`,
    ),
    check(
      "briefing_actions_kind_check",
      sql`${table.kind} in ('task', 'reminder', 'resolve')`,
    ),
    check(
      "briefing_actions_digest_check",
      sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "briefing_actions_result_check",
      sql`(${table.kind} = 'resolve') = (${table.entityId} is null)`,
    ),
  ],
);
