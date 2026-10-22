import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn } from "./common.js";
import { dreamingChanges } from "./dreaming.js";
import { accounts } from "./identity.js";
import { ingestReviewDecisionEnum } from "./ingestion.js";

export const dreamingReviews = pgTable(
  "dreaming_reviews",
  {
    changeId: uuid("change_id")
      .primaryKey()
      .references(() => dreamingChanges.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    decision: ingestReviewDecisionEnum("decision").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // Historical result identity survives deletion, like ingestion and mutation receipts.
    resultMemoryId: uuid("result_memory_id"),
    reviewerAccountId: uuid("reviewer_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    requestId: text("request_id").notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("dreaming_reviews_created_idx").on(table.createdAt, table.changeId),
    check(
      "dreaming_reviews_fingerprint_check",
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "dreaming_reviews_result_check",
      sql`(${table.decision} = 'accept') = (${table.resultMemoryId} is not null)`,
    ),
  ],
);
