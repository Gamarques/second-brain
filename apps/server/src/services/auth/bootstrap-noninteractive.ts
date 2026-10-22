/**
 * Creates the first OAuth account as the deployment's owner without a
 * terminal, for automated deployments.
 *
 * The interactive entry point in bootstrap-account.ts stays the documented
 * path for an operator at a terminal. This one reads the credentials from
 * standard input, so the password never reaches an environment variable, a
 * command line, `ps`, or the server's shell history. The transaction, replay
 * semantics, and fail-closed integrity checks are the shared store's.
 */
import "@second-brain/engine/env";

import { stdin } from "node:process";

import { createDatabaseRuntime } from "@second-brain/engine/database/client";
import { requireDatabaseConfiguration } from "@second-brain/engine/database/config";
import { reportStartupFailure } from "@second-brain/engine/env";
import { createConfiguredModelProvider } from "@second-brain/engine/runtime-config";
import { toBootstrapStartupError } from "./bootstrap-failure.js";
import {
  isAccountExistsFailure,
  ownerAlreadyExistsMessage,
  ownerCreatedPrefix,
  parseBootstrapCredentials,
  requirePipedBootstrapInput,
} from "./bootstrap-piped.js";
import { OAuthUserStore } from "./user-store.js";

function readStandardInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      value += chunk;
    });
    stdin.once("end", () => {
      resolve(value);
    });
    stdin.once("error", reject);
  });
}

async function main(): Promise<void> {
  requirePipedBootstrapInput(stdin);
  const { email, password } = parseBootstrapCredentials(
    await readStandardInput(),
  );
  requireDatabaseConfiguration();
  const models = createConfiguredModelProvider();

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
    process.stdout.write(`${ownerCreatedPrefix} ${account.email}\n`);
  } catch (error) {
    if (!isAccountExistsFailure(error)) throw error;
    // Re-running a deployment must not fail once the account is in place.
    process.stderr.write(`${ownerAlreadyExistsMessage}\n`);
  } finally {
    await runtime.close();
  }
}

main().catch((error) => reportStartupFailure(toBootstrapStartupError(error)));
