/**
 * Maps known account-bootstrap failures to EngineStartupError so
 * reportStartupFailure prints an actionable sentence instead of the generic
 * mask. Unknown errors pass through unchanged and stay masked, which keeps
 * connection strings and other values out of stderr.
 */
import { z } from "zod";

import { EngineStartupError } from "@second-brain/engine/env";

export const knownBootstrapFailureMessages: readonly string[] = [
  "The database already contains an account.",
  "The bootstrap state is invalid.",
  "The bootstrap state does not match this request.",
  "The bootstrap state could not be finalized.",
  "An account with this email already exists.",
  "Initial embedding spaces could not be provisioned safely.",
  "The password must contain at least 12 characters.",
  "The password is too long.",
  "The password confirmation does not match.",
  "Account bootstrap requires an interactive terminal.",
  "Account bootstrap was cancelled.",
];

export function toBootstrapStartupError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return new EngineStartupError("The account email address is invalid.");
  }
  if (
    error instanceof Error &&
    knownBootstrapFailureMessages.includes(error.message)
  ) {
    return new EngineStartupError(error.message);
  }
  return error;
}
