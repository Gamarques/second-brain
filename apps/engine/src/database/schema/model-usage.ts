import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { modelFailureReasons, modelOperations } from "../../domain/model-usage.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./common.js";

export const modelOperationEnum = pgEnum("model_operation", modelOperations);
export const modelFailureReasonEnum = pgEnum("model_failure_reason", modelFailureReasons);
export const modelRequestOutcomeEnum = pgEnum("model_request_outcome", ["succeeded", "failed"]);

export const modelRequests = pgTable("model_requests", {
  id: idColumn(),
  operation: modelOperationEnum("operation").notNull(),
  model: text("model").notNull(),
  occurredAt: createdAtColumn(),
  durationMs: integer("duration_ms").notNull(),
  outcome: modelRequestOutcomeEnum("outcome").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cost: doublePrecision("cost"),
  errorReason: modelFailureReasonEnum("error_reason"),
}, (table) => [
  index("model_requests_occurred_idx").on(table.occurredAt),
  index("model_requests_operation_occurred_idx").on(table.operation, table.occurredAt),
  check("model_requests_measurements_check", sql`${table.durationMs} >= 0 and (${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0) and (${table.cost} is null or (${table.cost} >= 0 and ${table.cost} < 'Infinity'::float8))`),
  check("model_requests_outcome_check", sql`(${table.outcome} = 'succeeded' and ${table.errorReason} is null) or (${table.outcome} = 'failed' and ${table.errorReason} is not null)`),
]);

/** One row per process, so rolling restarts cannot hide an older live instance. */
export const modelRuntimeInstances = pgTable("model_runtime_instances", {
  id: idColumn(),
  service: text("service").notNull(),
  configurationRevision: integer("configuration_revision").notNull(),
  models: jsonb("models").$type<Readonly<Record<string, string>>>().notNull(),
  startedAt: createdAtColumn(),
  lastSeenAt: updatedAtColumn(),
}, (table) => [index("model_runtime_instances_seen_idx").on(table.lastSeenAt)]);
