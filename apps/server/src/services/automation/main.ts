import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AutomationWorker } from "@second-brain/engine/domain";
import { reportStartupFailure } from "@second-brain/engine/env";

export interface AutomationWorkerProcessOptions {
  readonly shutdownSignals?: readonly NodeJS.Signals[];
  readonly restartRequested?: Promise<number>;
}

/**
 * Owns process shutdown only. Runtime composition supplies the internal worker;
 * no capability or transport can invoke this entry point.
 */
export async function serveAutomationWorker(
  worker: AutomationWorker,
  options: AutomationWorkerProcessOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const shutdownSignals = options.shutdownSignals ?? ["SIGINT", "SIGTERM"];
  const listeners = new Map<NodeJS.Signals, () => void>();

  for (const shutdownSignal of shutdownSignals) {
    const listener = () => controller.abort(`received-${shutdownSignal}`);
    listeners.set(shutdownSignal, listener);
    process.once(shutdownSignal, listener);
  }
  void options.restartRequested?.then(
    () => controller.abort("configuration-restart"),
    () => undefined,
  );

  try {
    await worker.run(controller.signal);
  } finally {
    controller.abort("worker-stopped");
    for (const [shutdownSignal, listener] of listeners) {
      process.removeListener(shutdownSignal, listener);
    }
    await worker.close();
  }
}

async function main(): Promise<void> {
  const { createSecondBrainAutomationRuntime } = await import("../../runtime.js");
  const runtime = await createSecondBrainAutomationRuntime();
  try {
    await serveAutomationWorker(runtime.worker, {
      restartRequested: runtime.restartRequested,
    });
  } finally {
    await runtime.close();
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
