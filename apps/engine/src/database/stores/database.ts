import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { schema } from "../schema/index.js";

export type SecondBrainSchema = typeof schema;

export type SecondBrainDatabase = NodePgDatabase<SecondBrainSchema>;

export type SecondBrainTransaction = Parameters<
  Parameters<SecondBrainDatabase["transaction"]>[0]
>[0];
