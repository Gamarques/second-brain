import { eq } from "drizzle-orm";

import {
  environmentConfigurationCatalog,
  type EditableEnvironmentVariableName,
  type EnvironmentConfigurationState,
  type SecretEnvironmentConfigurationEntry,
  type StoredEnvironmentConfigurationEntry,
} from "../../environment-configuration.js";
import { environmentConfiguration } from "../schema/admin.js";
import type { SecondBrainDatabase } from "./database.js";

const configurationNames = new Set<EditableEnvironmentVariableName>(
  environmentConfigurationCatalog.map(({ name }) => name),
);
const secretNames = new Set<EditableEnvironmentVariableName>(
  environmentConfigurationCatalog
    .filter(({ secret }) => secret)
    .map(({ name }) => name),
);
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("The stored environment configuration is invalid.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function base64Url(value: unknown, bytes?: number): string {
  if (typeof value !== "string" || !base64UrlPattern.test(value)) {
    fail("The stored secret envelope is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    (bytes !== undefined && decoded.length !== bytes) ||
    decoded.toString("base64url") !== value
  ) {
    fail("The stored secret envelope is invalid.");
  }
  return value;
}

function entry(
  name: EditableEnvironmentVariableName,
  value: unknown,
): StoredEnvironmentConfigurationEntry {
  const record = object(value);
  if (!secretNames.has(name)) {
    if (record.kind !== "plain" || typeof record.value !== "string") {
      fail(`The stored value for ${name} is invalid.`);
    }
    return { kind: "plain", value: record.value };
  }
  if (
    record.kind !== "secret" ||
    record.version !== 1 ||
    typeof record.digest !== "string" ||
    !digestPattern.test(record.digest)
  ) {
    fail("The stored secret envelope is invalid.");
  }
  return {
    kind: "secret",
    version: 1,
    iv: base64Url(record.iv, 12),
    ciphertext: base64Url(record.ciphertext),
    tag: base64Url(record.tag, 16),
    digest: record.digest,
  } satisfies SecretEnvironmentConfigurationEntry;
}

function entries(value: unknown): EnvironmentConfigurationState["entries"] {
  const result: Partial<
    Record<EditableEnvironmentVariableName, StoredEnvironmentConfigurationEntry>
  > = {};
  for (const [rawName, valueEntry] of Object.entries(object(value))) {
    if (!configurationNames.has(rawName as EditableEnvironmentVariableName)) {
      fail("The stored environment configuration contains an unknown name.");
    }
    const name = rawName as EditableEnvironmentVariableName;
    result[name] = entry(name, valueEntry);
  }
  return result;
}

/** Read-only engine view of durable configuration and restart requests. */
export class DrizzleRuntimeEnvironmentConfigurationStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async readForRuntime(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EnvironmentConfigurationState> {
    signal.throwIfAborted();
    const rows = await this.database
      .select()
      .from(environmentConfiguration)
      .where(eq(environmentConfiguration.id, 1))
      .limit(1);
    signal.throwIfAborted();
    const row = rows[0];
    if (row === undefined) {
      return { revision: 0, entries: {}, restartRequired: false, updatedAt: null };
    }
    if (!Number.isInteger(row.revision) || row.revision < 1) {
      fail("The stored environment configuration revision is invalid.");
    }
    return {
      revision: row.revision,
      entries: entries(row.entries),
      restartRequired: row.restartRequired,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async readRestartRequestForRuntime(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<number> {
    signal.throwIfAborted();
    const rows = await this.database
      .select({
        revision: environmentConfiguration.restartRequestedRevision,
      })
      .from(environmentConfiguration)
      .where(eq(environmentConfiguration.id, 1))
      .limit(1);
    signal.throwIfAborted();
    const revision = rows[0]?.revision ?? 0;
    if (!Number.isInteger(revision) || revision < 0) {
      fail("The stored environment restart revision is invalid.");
    }
    return revision;
  }
}
