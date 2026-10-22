/**
 * Input rules for the non-interactive first-account bootstrap.
 *
 * Kept free of side effects so the rules can be tested without a database, a
 * model provider, or an environment file. The entry point that applies them is
 * bootstrap-noninteractive.ts.
 */
import { EngineStartupError } from "@second-brain/engine/env";

/** The deployment installer matches stdout on this prefix to detect success. */
export const ownerCreatedPrefix = "OAuth owner created:";

/**
 * Written to stderr when the account is already present. The state the caller
 * asked for holds, so this is reported as success rather than a failure.
 */
export const ownerAlreadyExistsMessage =
  "The OAuth owner account already exists.";

export const credentialsRequiredMessage =
  "Account bootstrap requires an email and password on standard input.";
export const terminalRefusedMessage =
  "Account bootstrap must not read credentials from a terminal.";

/** The account is already present, whichever path created it. */
export const accountExistsMessages: readonly string[] = [
  "The database already contains an account.",
  "An account with this email already exists.",
];

export interface PipedBootstrapCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * A terminal would echo the password and leave it on screen. Refusing one also
 * keeps this entry point from being mistaken for the interactive bootstrap.
 */
export function requirePipedBootstrapInput(input: {
  readonly isTTY?: boolean;
}): void {
  if (input.isTTY === true) {
    throw new EngineStartupError(terminalRefusedMessage);
  }
}

/**
 * Takes the email from the first line and the password from the second. Only
 * the line ending is stripped: a password may contain leading or trailing
 * spaces, and trimming would silently store a different secret than the one
 * the operator supplied.
 */
export function parseBootstrapCredentials(
  input: string,
): PipedBootstrapCredentials {
  const [emailLine, passwordLine] = input.split("\n");
  const email = (emailLine ?? "").replace(/\r$/u, "").trim();
  const password = (passwordLine ?? "").replace(/\r$/u, "");
  if (email === "" || password === "") {
    throw new EngineStartupError(credentialsRequiredMessage);
  }
  return { email, password };
}

export function isAccountExistsFailure(error: unknown): boolean {
  return error instanceof Error && accountExistsMessages.includes(error.message);
}
