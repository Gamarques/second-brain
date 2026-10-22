/** Shared durable configuration contract consumed by supervised runtimes. */
import {
  createDecipheriv,
  createCipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";

import type { BrainAccessContext } from "./domain.js";
import type { EnvironmentRecord } from "./env.js";

export const environmentConfigurationEncryptionKeyName =
  "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY";

export class EnvironmentConfigurationKeyError extends Error {
  readonly code = "ENVIRONMENT_CONFIGURATION_KEY_INVALID";

  constructor() {
    super(
      "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY must be canonical base64url encoding of exactly 32 bytes.",
    );
    this.name = "EnvironmentConfigurationKeyError";
  }
}

export class EnvironmentConfigurationCorruptionError extends Error {
  readonly code = "ENVIRONMENT_CONFIGURATION_CORRUPT";

  constructor() {
    super("Stored environment configuration is invalid.");
    this.name = "EnvironmentConfigurationCorruptionError";
  }
}

export function parseEnvironmentConfigurationEncryptionKey(
  environment: EnvironmentRecord = process.env,
): Buffer {
  const encoded = environment[environmentConfigurationEncryptionKeyName];
  if (
    encoded === undefined ||
    encoded.length === 0 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new EnvironmentConfigurationKeyError();
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
    throw new EnvironmentConfigurationKeyError();
  }
  return decoded;
}

const editableEnvironmentVariableNames = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_ANSWER_MODEL",
  "OPENROUTER_INGESTION_MODEL",
  "OPENROUTER_DREAMING_MODEL",
  "OPENROUTER_VERIFICATION_MODEL",
  "OPENROUTER_REQUEST_TIMEOUT_MS",
  "OPENROUTER_APP_URL",
] as const;

export type EditableEnvironmentVariableName =
  (typeof editableEnvironmentVariableNames)[number];

export interface EnvironmentConfigurationCatalogItem {
  readonly name: EditableEnvironmentVariableName;
  readonly secret: boolean;
  readonly restartRequired: true;
}

/**
 * Infrastructure, authentication, network binding, provider endpoint, and
 * embedding identity variables are deliberately absent from this catalog.
 */
export const environmentConfigurationCatalog = Object.freeze([
  { name: "OPENROUTER_API_KEY", secret: true, restartRequired: true },
  { name: "OPENROUTER_ANSWER_MODEL", secret: false, restartRequired: true },
  { name: "OPENROUTER_INGESTION_MODEL", secret: false, restartRequired: true },
  { name: "OPENROUTER_DREAMING_MODEL", secret: false, restartRequired: true },
  { name: "OPENROUTER_VERIFICATION_MODEL", secret: false, restartRequired: true },
  { name: "OPENROUTER_REQUEST_TIMEOUT_MS", secret: false, restartRequired: true },
  { name: "OPENROUTER_APP_URL", secret: false, restartRequired: true },
] satisfies readonly EnvironmentConfigurationCatalogItem[]);

export interface PlainEnvironmentConfigurationEntry {
  readonly kind: "plain";
  readonly value: string;
}

export interface SecretEnvironmentConfigurationEntry {
  readonly kind: "secret";
  readonly version: 1;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
  /** A keyed comparison token. It is never returned by the public manager. */
  readonly digest: string;
}

export type StoredEnvironmentConfigurationEntry =
  | PlainEnvironmentConfigurationEntry
  | SecretEnvironmentConfigurationEntry;

export interface EnvironmentConfigurationState {
  readonly revision: number;
  readonly entries: Readonly<
    Partial<Record<EditableEnvironmentVariableName, StoredEnvironmentConfigurationEntry>>
  >;
  readonly restartRequired: boolean;
  readonly updatedAt: string | null;
}

export const environmentServiceRestartTargets = [
  "engine",
  "admin",
  "automation-worker",
] as const;

export type EnvironmentServiceRestartTarget =
  (typeof environmentServiceRestartTargets)[number];

export interface EnvironmentConfigurationRestartInput {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface EnvironmentConfigurationRestartStoreInput
  extends EnvironmentConfigurationRestartInput {
  readonly requestDigest: string;
}

export interface EnvironmentConfigurationRestartResult {
  readonly revision: number;
  readonly targets: readonly EnvironmentServiceRestartTarget[];
  readonly requestedAt: string;
  readonly replayed: boolean;
}

export interface StageEnvironmentConfigurationStoreChange {
  readonly name: EditableEnvironmentVariableName;
  readonly entry: StoredEnvironmentConfigurationEntry | null;
}

export interface StageEnvironmentConfigurationStoreInput {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly changes: readonly StageEnvironmentConfigurationStoreChange[];
}

export interface StagedEnvironmentConfiguration {
  readonly revision: number;
  readonly changedNames: readonly EditableEnvironmentVariableName[];
  readonly restartRequired: boolean;
  readonly updatedAt: string | null;
  readonly replayed: boolean;
}

export interface EnvironmentConfigurationStore {
  read(
    access: BrainAccessContext,
    signal?: AbortSignal,
  ): Promise<EnvironmentConfigurationState>;
  stage(
    access: BrainAccessContext,
    input: StageEnvironmentConfigurationStoreInput,
    signal?: AbortSignal,
  ): Promise<StagedEnvironmentConfiguration | null>;
  requestRestart(
    access: BrainAccessContext,
    input: EnvironmentConfigurationRestartStoreInput,
    signal?: AbortSignal,
  ): Promise<EnvironmentConfigurationRestartResult | null>;
}

export interface StageEnvironmentConfigurationInput {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly changes: readonly (
    | {
        readonly name: string;
        readonly operation: "set";
        readonly value: string;
      }
    | {
        readonly name: string;
        /** Clearing removes a staged override; omission always means keep. */
        readonly operation: "clear";
      }
  )[];
}

export type ListedEnvironmentVariable =
  | {
      readonly name: EditableEnvironmentVariableName;
      readonly secret: true;
      readonly configured: boolean;
      readonly restartRequired: true;
    }
  | {
      readonly name: EditableEnvironmentVariableName;
      readonly secret: false;
      readonly configured: boolean;
      readonly value: string | null;
      readonly restartRequired: true;
    };

export interface ListedEnvironmentConfiguration {
  readonly revision: number;
  readonly restartRequired: boolean;
  readonly updatedAt: string | null;
  readonly variables: readonly ListedEnvironmentVariable[];
}

export interface EnvironmentConfigurationManager {
  list(
    access: BrainAccessContext,
    signal?: AbortSignal,
  ): Promise<ListedEnvironmentConfiguration>;
  stage(
    access: BrainAccessContext,
    input: StageEnvironmentConfigurationInput,
    signal?: AbortSignal,
  ): Promise<StagedEnvironmentConfiguration | null>;
  restart(
    access: BrainAccessContext,
    input: EnvironmentConfigurationRestartInput,
    signal?: AbortSignal,
  ): Promise<EnvironmentConfigurationRestartResult | null>;
}

const catalogByName = new Map(
  environmentConfigurationCatalog.map((item) => [item.name, item] as const),
);

function requireEditableName(name: string): EnvironmentConfigurationCatalogItem {
  const item = catalogByName.get(name as EditableEnvironmentVariableName);
  if (item === undefined) {
    throw new Error(`${name} is not an editable environment variable.`);
  }
  return item;
}

function countScalars(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function validateValue(name: EditableEnvironmentVariableName, value: string): void {
  if (value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
    throw new Error(`${name} must not contain NUL, carriage return, or line feed characters.`);
  }
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must not be empty or contain surrounding whitespace.`);
  }
  if (countScalars(value) > 4_096) {
    throw new Error(`${name} must contain at most 4096 characters.`);
  }
  if (name === "OPENROUTER_REQUEST_TIMEOUT_MS") {
    if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
      throw new Error("OPENROUTER_REQUEST_TIMEOUT_MS must be a positive integer.");
    }
  }
  if (name === "OPENROUTER_APP_URL") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("OPENROUTER_APP_URL must be a valid HTTP or HTTPS URL.");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("OPENROUTER_APP_URL must be a valid HTTP or HTTPS URL.");
    }
  }
}

function hmac(key: BinaryLike, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function secretDigest(
  key: Buffer,
  name: EditableEnvironmentVariableName,
  value: string,
): string {
  return hmac(key, JSON.stringify(["environment-secret", 1, name, value]));
}

function encryptSecret(
  key: Buffer,
  name: EditableEnvironmentVariableName,
  value: string,
): SecretEnvironmentConfigurationEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${name}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    kind: "secret",
    version: 1,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    digest: secretDigest(key, name, value),
  };
}

function decodeCanonicalBase64Url(value: string, length?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new EnvironmentConfigurationCorruptionError();
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    decoded.toString("base64url") !== value ||
    (length !== undefined && decoded.length !== length)
  ) {
    throw new EnvironmentConfigurationCorruptionError();
  }
  return decoded;
}

function decryptSecret(
  key: Buffer,
  name: EditableEnvironmentVariableName,
  entry: SecretEnvironmentConfigurationEntry,
): string {
  try {
    if (
      entry.kind !== "secret" ||
      entry.version !== 1 ||
      !/^[0-9a-f]{64}$/u.test(entry.digest)
    ) {
      throw new EnvironmentConfigurationCorruptionError();
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      decodeCanonicalBase64Url(entry.iv, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(`${name}:v1`, "utf8"));
    decipher.setAuthTag(decodeCanonicalBase64Url(entry.tag, 16));
    const clear = Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(entry.ciphertext)),
      decipher.final(),
    ]);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(clear);
    const expectedDigest = Buffer.from(secretDigest(key, name, value), "hex");
    const storedDigest = Buffer.from(entry.digest, "hex");
    if (
      storedDigest.length !== expectedDigest.length ||
      !timingSafeEqual(storedDigest, expectedDigest)
    ) {
      throw new EnvironmentConfigurationCorruptionError();
    }
    validateValue(name, value);
    return value;
  } catch {
    throw new EnvironmentConfigurationCorruptionError();
  }
}

/** Decrypts the trusted startup snapshot into an env-shaped, staged overlay. */
export function environmentConfigurationOverlay(
  state: EnvironmentConfigurationState,
  encryptionKey: Uint8Array,
): EnvironmentRecord {
  if (encryptionKey.byteLength !== 32) throw new EnvironmentConfigurationKeyError();
  const key = Buffer.from(encryptionKey);
  try {
    const overlay: EnvironmentRecord = {};
    for (const [rawName, entry] of Object.entries(state.entries)) {
      const item = catalogByName.get(rawName as EditableEnvironmentVariableName);
      if (item === undefined || entry === undefined) {
        throw new EnvironmentConfigurationCorruptionError();
      }
      if (item.secret) {
        if (entry.kind !== "secret") throw new EnvironmentConfigurationCorruptionError();
        overlay[item.name] = decryptSecret(key, item.name, entry);
      } else {
        if (entry.kind !== "plain") throw new EnvironmentConfigurationCorruptionError();
        validateValue(item.name, entry.value);
        overlay[item.name] = entry.value;
      }
    }
    return overlay;
  } catch {
    throw new EnvironmentConfigurationCorruptionError();
  }
}

function requestDigest(
  key: Buffer,
  input: StageEnvironmentConfigurationInput,
): string {
  const canonicalChanges = [...input.changes]
    .map((change) =>
      change.operation === "set"
        ? ([change.name, "set", change.value] as const)
        : ([change.name, "clear"] as const),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return hmac(
    key,
    JSON.stringify({
      version: 1,
      expectedRevision: input.expectedRevision,
      changes: canonicalChanges,
    }),
  );
}

function restartRequestDigest(
  key: Buffer,
  input: EnvironmentConfigurationRestartInput,
): string {
  return hmac(
    key,
    JSON.stringify({ version: 1, expectedRevision: input.expectedRevision }),
  );
}

function validateRestartInput(input: EnvironmentConfigurationRestartInput): void {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive integer.");
  }
  if (
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200 ||
    input.idempotencyKey !== input.idempotencyKey.trim()
  ) {
    throw new Error("idempotencyKey must contain between 1 and 200 characters.");
  }
}

function validateStageInput(input: StageEnvironmentConfigurationInput): void {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  if (
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200 ||
    input.idempotencyKey !== input.idempotencyKey.trim()
  ) {
    throw new Error("idempotencyKey must contain between 1 and 200 characters.");
  }
  if (input.changes.length < 1) {
    throw new Error("changes must contain at least one variable.");
  }
  if (input.changes.length > environmentConfigurationCatalog.length) {
    throw new Error("changes contains too many variables.");
  }
  const names = new Set<string>();
  for (const change of input.changes) {
    const item = requireEditableName(change.name);
    if (names.has(item.name)) {
      throw new Error("changes must not contain duplicate names.");
    }
    names.add(item.name);
    if (change.operation === "set") validateValue(item.name, change.value);
  }
}

function publicState(state: EnvironmentConfigurationState): ListedEnvironmentConfiguration {
  return {
    revision: state.revision,
    restartRequired: state.restartRequired,
    updatedAt: state.updatedAt,
    variables: environmentConfigurationCatalog.map((item): ListedEnvironmentVariable => {
      const entry = state.entries[item.name];
      if (item.secret) {
        return {
          name: item.name,
          secret: true,
          configured: entry !== undefined,
          restartRequired: true,
        };
      }
      if (entry !== undefined && entry.kind !== "plain") {
        throw new Error(`Stored environment configuration for ${item.name} is invalid.`);
      }
      return {
        name: item.name,
        secret: false,
        configured: entry !== undefined,
        value: entry?.value ?? null,
        restartRequired: true,
      };
    }),
  };
}

export function createEnvironmentConfigurationManager(options: {
  readonly store: EnvironmentConfigurationStore;
  readonly encryptionKey: Uint8Array;
}): EnvironmentConfigurationManager {
  if (options.encryptionKey.byteLength !== 32) {
    throw new Error("encryptionKey must contain exactly 32 bytes.");
  }
  const encryptionKey = Buffer.from(options.encryptionKey);
  return {
    async list(access, signal) {
      signal?.throwIfAborted();
      const state = await options.store.read(access, signal);
      signal?.throwIfAborted();
      return publicState(state);
    },

    async stage(access, input, signal) {
      signal?.throwIfAborted();
      validateStageInput(input);
      const changes = input.changes.map((change): StageEnvironmentConfigurationStoreChange => {
        const item = requireEditableName(change.name);
        return {
          name: item.name,
          entry:
            change.operation === "clear"
              ? null
              : item.secret
                ? encryptSecret(encryptionKey, item.name, change.value)
                : { kind: "plain", value: change.value },
        };
      });
      const result = await options.store.stage(
        access,
        {
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          requestDigest: requestDigest(encryptionKey, input),
          changes,
        },
        signal,
      );
      signal?.throwIfAborted();
      return result;
    },

    async restart(access, input, signal) {
      signal?.throwIfAborted();
      validateRestartInput(input);
      const result = await options.store.requestRestart(
        access,
        {
          ...input,
          requestDigest: restartRequestDigest(encryptionKey, input),
        },
        signal,
      );
      signal?.throwIfAborted();
      return result;
    },
  };
}
