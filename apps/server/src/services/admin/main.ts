import { DrizzleNotificationStore } from "@second-brain/engine/database/stores/notification-store";
import { HttpNotificationProvider, createNotificationCipher } from "@second-brain/engine/providers/notification-provider";
import { appendAdminAuditEvent } from "../shared/audit-store.js";
import { DrizzleBriefingStore } from "@second-brain/engine/database/stores/briefing-store";
import { createDrizzleBrainQuestionService } from "@second-brain/engine/database/stores/brain-question-service";
import { DrizzleProjectOverviewStore } from "@second-brain/engine/database/stores/project-overview-store";
import { DrizzleLearningReviewStore } from "@second-brain/engine/database/stores/learning-review-store";
import { createDreamingMemoryEmbedder } from "@second-brain/engine/database/stores/embedding-space-store";
import { configuredModelsForDatabase } from "@second-brain/engine/runtime";
import { DrizzleAdminDreamingStore } from "./persistence/dreaming-store.js";
import { DrizzleModelUsageStore } from "@second-brain/engine/database/stores/model-usage-store";
import { createModelConfigurationService } from "@second-brain/engine/providers/model-configuration";
import { resolvedEnvironmentForDatabase } from "@second-brain/engine/runtime";
/** Executable composition root for the private browser administration surface. */
import "@second-brain/engine/env";

import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSecondBrainAdminEngine } from "./engine.js";
import { createAdminHttpHandler } from "./http.js";
import { createBrainPackTransferDependencies } from "./packs/resolve.js";
import { createAdminServerApp, startAdminServer } from "./server.js";
import { DrizzleAutomationStore } from "../automation/persistence/store.js";
import {
  createEnvironmentConfigurationManager,
  parseEnvironmentConfigurationEncryptionKey,
} from "@second-brain/engine/environment-configuration";
import {
  createAdminOAuthSessionResolver,
  readAdminOAuthConfiguration,
} from "./session.js";
import { createDatabase } from "@second-brain/engine/database/client";
import { DrizzleBrainAccessStore } from "@second-brain/engine/database/stores/access-store";
import { DrizzleAdminAutomationStore } from "./persistence/automation-store.js";
import { DrizzleAdminBrainMapStore } from "./persistence/brain-map-store.js";
import { DrizzleAdminAuditStore } from "../shared/audit-store.js";
import { DrizzleEnvironmentConfigurationStore } from "./persistence/environment-configuration-store.js";
import { reportStartupFailure, type EnvironmentRecord } from "@second-brain/engine/env";
import { createSecondBrainRuntime } from "@second-brain/engine/runtime";

export interface AdminServerConfiguration {
  readonly hostname: string;
  readonly port: number;
  readonly assetsDirectory: string;
}

function optionalTrimmed(
  environment: EnvironmentRecord,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === "") return undefined;
  if (value.trim() !== value || value.includes("\u0000")) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

export function readAdminServerConfiguration(
  environment: EnvironmentRecord = process.env,
  workingDirectory = process.cwd(),
): AdminServerConfiguration {
  const portText = optionalTrimmed(environment, "SECOND_BRAIN_ADMIN_PORT") ?? "3002";
  if (!/^[1-9][0-9]{0,4}$/u.test(portText)) {
    throw new Error("SECOND_BRAIN_ADMIN_PORT is invalid.");
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("SECOND_BRAIN_ADMIN_PORT is invalid.");
  }
  return {
    hostname:
      optionalTrimmed(environment, "SECOND_BRAIN_ADMIN_HOST") ?? "127.0.0.1",
    port,
    assetsDirectory:
      optionalTrimmed(environment, "SECOND_BRAIN_ADMIN_ASSETS_DIR") ??
      resolve(workingDirectory, "admin-ui"),
  };
}

/**
 * Hono sees the proxy-facing Host with an internal HTTP scheme. Trust scheme
 * rewriting only when both single-valued forwarding headers exactly identify
 * the configured public origin; every ambiguous request stays unmodified and
 * is rejected by the downstream exact-origin check.
 */
export function normalizeAdminProxyRequest(
  request: Request,
  trustedOrigin: string,
): Request {
  const current = new URL(request.url);
  if (current.origin === trustedOrigin) return request;
  const trusted = new URL(trustedOrigin);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  if (
    forwardedHost !== trusted.host ||
    forwardedProtocol !== trusted.protocol.slice(0, -1) ||
    forwardedHost.includes(",") ||
    forwardedProtocol.includes(",")
  ) {
    return request;
  }
  const normalized = new URL(`${current.pathname}${current.search}`, trusted);
  return new Request(normalized, request);
}

async function main(): Promise<void> {
  const environment = process.env;
  const oauthConfiguration = readAdminOAuthConfiguration(environment);
  const serverConfiguration = readAdminServerConfiguration(environment);
  await access(
    resolve(serverConfiguration.assetsDirectory, "index.html"),
    constants.R_OK,
  );

  // The worker's store handles cancellation so a pack run and its job stop through one implementation.
  const runtime = await createSecondBrainRuntime(environment, "admin", {
    automation: (engineDatabase) => new DrizzleAutomationStore(engineDatabase),
  });
  const database = createDatabase(runtime.pool);
  try {
    const sessions = createAdminOAuthSessionResolver(database, oauthConfiguration);
    const configuration = createEnvironmentConfigurationManager({
      store: new DrizzleEnvironmentConfigurationStore(database),
      encryptionKey: parseEnvironmentConfigurationEncryptionKey(environment),
    });
    const audit = new DrizzleAdminAuditStore(database);
    const modelUsage = new DrizzleModelUsageStore(database);
    const { models: reviewModels } = await configuredModelsForDatabase(database, environment);
    const adminEngine = createSecondBrainAdminEngine({
      modelUsage,
      notifications: new DrizzleNotificationStore(database, { cipher: createNotificationCipher(parseEnvironmentConfigurationEncryptionKey(environment)), provider: new HttpNotificationProvider(), encryptionAvailable: true, async audit(tx, actor, channel, signal) { await appendAdminAuditEvent(tx, actor, { category: "administration", action: "notification_channel_saved", outcome: "succeeded", targetType: "notification_channel", targetId: channel.id, errorCode: null, metadata: { kind: channel.kind, enabled: channel.enabled, revision: channel.revision } }, signal); } }),
      briefing: new DrizzleBriefingStore(database),
      projectOverview: new DrizzleProjectOverviewStore(database),
      questions: createDrizzleBrainQuestionService(database, reviewModels.provider),
      models: createModelConfigurationService({ async read(signal) { signal.throwIfAborted(); return resolvedEnvironmentForDatabase(database, environment); } }, (observation) => modelUsage.record(observation)),
      access: new DrizzleBrainAccessStore(database),
      automation: new DrizzleAdminAutomationStore(database),
      dreaming: new DrizzleAdminDreamingStore(database),
      learning: new DrizzleLearningReviewStore(database, { ...createDreamingMemoryEmbedder(database, reviewModels.provider), verifier: reviewModels.provider }),
      audit,
      brainMap: new DrizzleAdminBrainMapStore(database),
      configuration,
    });
    const normalized = (request: Request) =>
      normalizeAdminProxyRequest(request, oauthConfiguration.issuer);
    const adminHttp = createAdminHttpHandler({
      trustedOrigin: oauthConfiguration.issuer,
      sessions,
      publicEngine: runtime.engine,
      adminEngine,
      audit,
      packs: createBrainPackTransferDependencies(database),
    });
    const app = createAdminServerApp({
      adminHttp(request) {
        return adminHttp(normalized(request));
      },
      assetsDirectory: serverConfiguration.assetsDirectory,
    });
    const server = startAdminServer(app, serverConfiguration);
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        await new Promise<void>((complete) => server.close(() => complete()));
        await runtime.close();
      })();
      return closing;
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void close().catch(() => {
          process.exitCode = 1;
        });
      });
    }
    if (runtime.restartRequested !== null) {
      void runtime.restartRequested.then(
        () => {
          void close().then(
            () => process.exit(0),
            () => process.exit(1),
          );
        },
        () => undefined,
      );
    }
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  pathToFileURL(resolve(entryPoint)).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  main().catch(reportStartupFailure);
}
