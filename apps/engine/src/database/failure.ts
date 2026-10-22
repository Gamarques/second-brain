/**
 * Maps well-known database startup failures to EngineStartupError so
 * reportStartupFailure prints an actionable sentence. The password case is
 * the classic Compose footgun: POSTGRES_PASSWORD only applies when the
 * volume is first initialized, so a later .env change breaks authentication.
 * Unknown errors pass through unchanged and stay masked.
 */
import { EngineStartupError } from "../env.js";

const messagesByCode: Readonly<Record<string, string>> = {
  "28P01":
    "The database rejected the password; POSTGRES_PASSWORD does not match the initialized database volume.",
  "28000":
    "The database rejected the password; POSTGRES_PASSWORD does not match the initialized database volume.",
  "3D000": "The database does not exist.",
  ECONNREFUSED: "The database is not reachable.",
  ETIMEDOUT: "The database is not reachable.",
  ENOTFOUND: "The database is not reachable.",
  EHOSTUNREACH: "The database is not reachable.",
  ACTIVE_EMBEDDING_SPACE_MISMATCH:
    "Active embedding spaces are missing or do not match the configured embedding provider. Bootstrap the owner account before the engine can start.",
};

export function toDatabaseStartupError(error: unknown): unknown {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      const message = messagesByCode[code];
      if (message !== undefined) return new EngineStartupError(message);
    }
  }
  return error;
}
