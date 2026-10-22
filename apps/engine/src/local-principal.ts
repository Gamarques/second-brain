import type { Principal } from "@invokta/core";

import { EngineStartupError, type EnvironmentRecord } from "./env.js";

const accountIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Returns the explicit account used by trusted local execution channels. */
export function localPrincipal(
  environment: EnvironmentRecord = process.env,
): Principal {
  const accountId = environment.SECOND_BRAIN_ACCOUNT_ID?.trim();
  if (accountId === undefined || !accountIdPattern.test(accountId)) {
    throw new EngineStartupError(
      "SECOND_BRAIN_ACCOUNT_ID must be a valid account UUID for local execution.",
    );
  }
  return { id: accountId };
}
