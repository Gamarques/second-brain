/** Creates the first OAuth account as the deployment's owner. */
import "@second-brain/engine/env";

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { createDatabaseRuntime } from "@second-brain/engine/database/client";
import { requireDatabaseConfiguration } from "@second-brain/engine/database/config";
import { reportStartupFailure } from "@second-brain/engine/env";
import { createConfiguredModelProvider } from "@second-brain/engine/runtime-config";
import { toBootstrapStartupError } from "./bootstrap-failure.js";
import { requireInteractiveBootstrapTerminal } from "./bootstrap-terminal.js";
import { OAuthUserStore } from "./user-store.js";

function hiddenInput(prompt: string): Promise<string> {
  requireInteractiveBootstrapTerminal(stdin, stdout);
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Account bootstrap was cancelled."));
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  requireInteractiveBootstrapTerminal(stdin, stdout);
  requireDatabaseConfiguration();
  const models = createConfiguredModelProvider();
  const reader = createInterface({ input: stdin, output: stdout });
  let email: string;
  try {
    email = await reader.question("Account email: ");
  } finally {
    reader.close();
  }
  const password = await hiddenInput("Account password: ");
  const confirmation = await hiddenInput("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("The password confirmation does not match.");
  }

  const runtime = createDatabaseRuntime();
  try {
    const account = await new OAuthUserStore(
      runtime.database,
    ).createBootstrapAccount(
      email,
      password,
      models.embeddingIdentity,
      new AbortController().signal,
    );
    process.stdout.write(`OAuth account ready: ${account.email}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => reportStartupFailure(toBootstrapStartupError(error)));
