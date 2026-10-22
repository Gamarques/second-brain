import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { EnvironmentRecord } from "../env.js";
import { databasePoolConfig } from "./config.js";
import { schema } from "./schema/index.js";

export type SecondBrainDatabase = NodePgDatabase<typeof schema>;

export function createDatabasePool(
  environment: EnvironmentRecord = process.env,
): Pool {
  return new Pool({
    ...databasePoolConfig(environment),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 20,
    query_timeout: 35_000,
    statement_timeout: 30_000,
  });
}

export function createDatabase(pool: Pool): SecondBrainDatabase {
  return drizzle(pool, { schema });
}

export interface DatabaseRuntime {
  readonly pool: Pool;
  readonly database: SecondBrainDatabase;
  close(): Promise<void>;
}

export function createDatabaseRuntime(
  environment: EnvironmentRecord = process.env,
): DatabaseRuntime {
  const pool = createDatabasePool(environment);
  return {
    pool,
    database: createDatabase(pool),
    close: () => pool.end(),
  };
}
