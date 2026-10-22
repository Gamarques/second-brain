import { DrizzleNotificationStore } from "@second-brain/engine/database/stores/notification-store";
import { HttpNotificationProvider, createNotificationCipher } from "@second-brain/engine/providers/notification-provider";
import { parseEnvironmentConfigurationEncryptionKey } from "@second-brain/engine/environment-configuration";
import { createReminderDispatcher } from "./services/automation/reminder-runner.js";
import { DrizzleModelUsageStore } from "@second-brain/engine/database/stores/model-usage-store";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { SECOND_BRAIN_VERSION } from "@second-brain/engine/version";
import { monitorEnvironmentRestart } from "@second-brain/engine/restart-monitor";
import { configuredModelsForDatabase } from "@second-brain/engine/runtime";

import { createBrainPackImportRunner } from "./services/automation/brain-pack-runner.js";
import { createDreamingRunner } from "./services/automation/dreaming-runner.js";
import { createJsonAutomationWorkerLogger } from "./services/automation/logger.js";
import {
  createAutomationWorker,
  type AutomationWorkerService,
} from "./services/automation/worker.js";
import { createDatabase, createDatabasePool } from "@second-brain/engine/database/client";
import { requireDatabaseConfiguration } from "@second-brain/engine/database/config";
import { toDatabaseStartupError } from "@second-brain/engine/database/failure";
import { assertMigrationsCurrent } from "@second-brain/engine/database/migrate";
import { DrizzleAutomationStore } from "./services/automation/persistence/store.js";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleBrainPackArtifactStore } from "@second-brain/engine/database/stores/brain-pack-artifact-store";
import { DrizzleBrainPackStore } from "@second-brain/engine/database/stores/brain-pack-store";
import { DrizzleDreamingStore } from "@second-brain/engine/database/stores/dreaming-store";
import {
  DrizzleEmbeddingSpaceStore,
  assertActiveEmbeddingSpacesMatchProvider,
  createDreamingMemoryEmbedder,
  embeddingProviderFingerprint,
} from "@second-brain/engine/database/stores/embedding-space-store";
import { createBrainPackImportService } from "@second-brain/engine/domain/brain-pack-import";
import { EngineStartupError, type EnvironmentRecord } from "@second-brain/engine/env";

export interface SecondBrainAutomationRuntime {
  readonly worker: AutomationWorkerService;
  readonly pool: Pool;
  readonly restartRequested: Promise<number>;
  close(): Promise<void>;
}

function workerId(environment: EnvironmentRecord): string {
  const configured = environment.SECOND_BRAIN_WORKER_ID?.trim();
  if (configured === undefined || configured === "") {
    return `second-brain-${process.pid}-${randomUUID()}`;
  }
  if (configured.length > 200 || !/^[a-zA-Z0-9._:-]+$/u.test(configured)) {
    throw new EngineStartupError("SECOND_BRAIN_WORKER_ID is invalid.");
  }
  return configured;
}

/** Creates the scheduled internal worker; it has no engine or capability path. */
export async function createSecondBrainAutomationRuntime(
  environment: EnvironmentRecord = process.env,
): Promise<SecondBrainAutomationRuntime> {
  requireDatabaseConfiguration(environment);
  const id = workerId(environment);
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
    const dreamingStore = new DrizzleDreamingStore(database);
    const notificationProvider = new HttpNotificationProvider();
    const notifications = new DrizzleNotificationStore(database, { cipher: createNotificationCipher(parseEnvironmentConfigurationEncryptionKey(environment)), provider: notificationProvider, encryptionAvailable: true });
    const packs = new DrizzleBrainPackStore(database);
    const packArtifacts = new DrizzleBrainPackArtifactStore(database);
    const worker = createAutomationWorker({
      runners: {
        brain_pack_import: createBrainPackImportRunner({
          service: createBrainPackImportService({
            store: packs,
            access: new DrizzleBrainAccessStore(database),
            embeddingSpaces: new DrizzleEmbeddingSpaceStore(database),
            embeddings: models.provider,
          }),
          runs: packs,
          artifacts: packArtifacts,
        }),
      },
      reminders: createReminderDispatcher(notifications, notificationProvider),
      workerId: id,
      workerVersion: SECOND_BRAIN_VERSION,
      logger: createJsonAutomationWorkerLogger(),
      automationStore: new DrizzleAutomationStore(database),
      dreamingStore,
      dreamingRunner: createDreamingRunner({
        store: dreamingStore,
        provider: models.provider,
        verifier: models.provider,
        embedder: createDreamingMemoryEmbedder(database, models.provider),
      }),
    });
    const modelMonitor = await new DrizzleModelUsageStore(database).monitorRuntime("automation-worker", configurationRevision, models.modelNames);
    let closing: Promise<void> | undefined;
    const restartMonitor = monitorEnvironmentRestart(
      configuration,
      configurationRevision,
    );
    return {
      worker,
      pool,
      restartRequested: restartMonitor.requested,
      close() {
        closing ??= (async () => {
          restartMonitor.close();
          try {
            await worker.close();
          } finally {
            try { await modelMonitor.close(); } finally { await pool.end(); }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      await pool.end();
    } catch {
      // Startup validation failure remains the primary failure.
    }
    throw toDatabaseStartupError(error);
  }
}
