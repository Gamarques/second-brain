import { DrizzleModelUsageStore } from "./database/stores/model-usage-store.js";
import type { Pool } from "pg";

import {
  createSecondBrainEngine,
  type SecondBrainEngineDependencies,
} from "./engine.js";
import {
  environmentConfigurationOverlay,
  parseEnvironmentConfigurationEncryptionKey,
} from "./environment-configuration.js";
import {
  monitorEnvironmentRestart,
  type EnvironmentRestartMonitor,
} from "./restart-monitor.js";
import { createDatabase, createDatabasePool } from "./database/client.js";
import { requireDatabaseConfiguration } from "./database/config.js";
import { toDatabaseStartupError } from "./database/failure.js";
import { assertMigrationsCurrent } from "./database/migrate.js";
import {
  assertActiveEmbeddingSpacesMatchProvider,
  embeddingProviderFingerprint,
} from "./database/stores/embedding-space-store.js";
import { DrizzleRuntimeEnvironmentConfigurationStore } from "./database/stores/runtime-environment-configuration-store.js";
import { createDrizzleEngineDependencies } from "./engine-dependencies.js";
import type { EnvironmentRecord } from "./env.js";
import { createConfiguredModelProvider } from "./runtime-config.js";

export interface SecondBrainRuntime {
  readonly engine: ReturnType<typeof createSecondBrainEngine>;
  readonly pool: Pool;
  readonly restartRequested: Promise<number> | null;
  close(): Promise<void>;
}

export async function resolvedEnvironmentForDatabase(
  database: ReturnType<typeof createDatabase>,
  environment: EnvironmentRecord,
) {
  const configuration = new DrizzleRuntimeEnvironmentConfigurationStore(database);
  const state = await configuration.readForRuntime();
  const overlay =
    Object.keys(state.entries).length === 0
      ? {}
      : environmentConfigurationOverlay(
          state,
          parseEnvironmentConfigurationEncryptionKey(environment),
        );
  return { configuration, configurationRevision: state.revision, environment: { ...environment, ...overlay } };
}

export async function configuredModelsForDatabase(database: ReturnType<typeof createDatabase>, environment: EnvironmentRecord) {
  const resolved = await resolvedEnvironmentForDatabase(database, environment);
  const usage = new DrizzleModelUsageStore(database);
  return { configuration: resolved.configuration, configurationRevision: resolved.configurationRevision, models: createConfiguredModelProvider(resolved.environment, (observation) => usage.record(observation)) };
}

export function composeSecondBrainRuntime(
  pool: Pool,
  dependencies: SecondBrainEngineDependencies,
  restartMonitor?: EnvironmentRestartMonitor,
  modelMonitor?: { close(): Promise<void> },
): SecondBrainRuntime {
  const engine = createSecondBrainEngine(dependencies);
  let closing: Promise<void> | undefined;

  return {
    engine,
    pool,
    restartRequested: restartMonitor?.requested ?? null,
    close() {
      closing ??= (async () => {
        restartMonitor?.close();
        try { await modelMonitor?.close(); } finally { await pool.end(); }
      })();
      return closing;
    },
  };
}

export interface SecondBrainRuntimeOptions {
  /**
   * Builds the automation store the engine hands to capabilities that ask a
   * job to stop. The server passes its worker's store so cancellation and
   * execution share one implementation; on its own the engine falls back to
   * its job control.
   */
  readonly automation?: (
    database: ReturnType<typeof createDatabase>,
  ) => SecondBrainEngineDependencies["automation"];
}

export async function createSecondBrainRuntime(
  environment: EnvironmentRecord = process.env,
  service: "engine" | "admin" = "engine",
  options: SecondBrainRuntimeOptions = {},
): Promise<SecondBrainRuntime> {
  requireDatabaseConfiguration(environment);
  const pool = createDatabasePool(environment);

  try {
    await assertMigrationsCurrent(pool);
    const database = createDatabase(pool);
    const { configuration, configurationRevision, models } =
      await configuredModelsForDatabase(database, environment);
    await assertActiveEmbeddingSpacesMatchProvider(
      database,
      embeddingProviderFingerprint(models.provider),
      new AbortController().signal,
    );

    return composeSecondBrainRuntime(
      pool,
      createDrizzleEngineDependencies(
        database,
        models.provider,
        options.automation === undefined ? {} : { automation: options.automation(database) },
      ),
      monitorEnvironmentRestart(configuration, configurationRevision),
      await new DrizzleModelUsageStore(database).monitorRuntime(service, configurationRevision, models.modelNames),
    );
  } catch (error) {
    try {
      await pool.end();
    } catch {
      // Startup validation failure remains the primary failure.
    }
    throw toDatabaseStartupError(error);
  }
}
