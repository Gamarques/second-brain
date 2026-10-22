import { and, eq, sql } from "drizzle-orm";

import {
  environmentConfigurationCatalog,
  type EditableEnvironmentVariableName,
  type EnvironmentConfigurationState,
  type EnvironmentConfigurationRestartResult,
  type EnvironmentConfigurationRestartStoreInput,
  type EnvironmentConfigurationStore,
  environmentServiceRestartTargets,
  type SecretEnvironmentConfigurationEntry,
  type StageEnvironmentConfigurationStoreInput,
  type StagedEnvironmentConfiguration,
  type StoredEnvironmentConfigurationEntry,
} from "@second-brain/engine/environment-configuration";
import type { BrainAccessContext } from "@second-brain/engine/domain";
import {
  environmentConfiguration,
  environmentConfigurationChanges,
  environmentConfigurationRestartRequests,
} from "@second-brain/engine/database/schema/admin";
import {
  appendAdminAuditEvent,
  resolveAdminAuditActorAlias,
} from "../../shared/audit-store.js";
import { authorizeBrainTransaction } from "@second-brain/engine/database/stores/authorization";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";

const configurationNames = new Set<EditableEnvironmentVariableName>(
  environmentConfigurationCatalog.map(({ name }) => name),
);
const secretNames = new Set<EditableEnvironmentVariableName>(
  environmentConfigurationCatalog.filter(({ secret }) => secret).map(({ name }) => name),
);
const digestPattern = /^[0-9a-f]{64}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const defaultSignal = new AbortController().signal;

export class EnvironmentConfigurationStoreContractError extends Error {
  readonly code = "ENVIRONMENT_CONFIGURATION_STORE_CONTRACT_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "EnvironmentConfigurationStoreContractError";
  }
}

function fail(message: string): never {
  throw new EnvironmentConfigurationStoreContractError(message);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editableName(value: string): EditableEnvironmentVariableName {
  if (!configurationNames.has(value as EditableEnvironmentVariableName)) {
    fail("The stored environment configuration contains an unknown name.");
  }
  return value as EditableEnvironmentVariableName;
}

function decodeBase64Url(value: unknown, name: string, exactBytes?: number): string {
  if (typeof value !== "string" || !base64UrlPattern.test(value)) {
    fail(`The stored secret ${name} is invalid.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || (exactBytes !== undefined && decoded.length !== exactBytes)) {
    fail(`The stored secret ${name} is invalid.`);
  }
  if (decoded.toString("base64url") !== value) {
    fail(`The stored secret ${name} is invalid.`);
  }
  return value;
}

function decodeSecret(value: Readonly<Record<string, unknown>>): SecretEnvironmentConfigurationEntry {
  if (
    value.kind !== "secret" ||
    value.version !== 1 ||
    typeof value.digest !== "string" ||
    !digestPattern.test(value.digest)
  ) {
    fail("The stored secret envelope is invalid.");
  }
  return {
    kind: "secret",
    version: 1,
    iv: decodeBase64Url(value.iv, "initialization vector", 12),
    ciphertext: decodeBase64Url(value.ciphertext, "ciphertext"),
    tag: decodeBase64Url(value.tag, "authentication tag", 16),
    digest: value.digest,
  };
}

function decodeEntry(
  name: EditableEnvironmentVariableName,
  value: unknown,
): StoredEnvironmentConfigurationEntry {
  if (!isObject(value)) fail(`The stored value for ${name} is invalid.`);
  if (secretNames.has(name)) return decodeSecret(value);
  if (value.kind !== "plain" || typeof value.value !== "string") {
    fail(`The stored value for ${name} is invalid.`);
  }
  return { kind: "plain", value: value.value };
}

function decodeEntries(
  value: unknown,
): EnvironmentConfigurationState["entries"] {
  if (!isObject(value)) fail("The stored environment configuration is invalid.");
  const result: Partial<
    Record<EditableEnvironmentVariableName, StoredEnvironmentConfigurationEntry>
  > = {};
  for (const [rawName, entry] of Object.entries(value)) {
    const name = editableName(rawName);
    result[name] = decodeEntry(name, entry);
  }
  return result;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    fail("The stored environment configuration timestamp is invalid.");
  }
  return value.toISOString();
}

function mapConfigurationRow(
  row: typeof environmentConfiguration.$inferSelect,
): EnvironmentConfigurationState {
  if (!Number.isInteger(row.revision) || row.revision < 1) {
    fail("The stored environment configuration revision is invalid.");
  }
  return {
    revision: row.revision,
    entries: decodeEntries(row.entries),
    restartRequired: row.restartRequired,
    updatedAt: iso(row.updatedAt),
  };
}

function validateStageInput(input: StageEnvironmentConfigurationStoreInput): void {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    fail("expectedRevision must be a non-negative integer.");
  }
  if (
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200 ||
    input.idempotencyKey !== input.idempotencyKey.trim()
  ) {
    fail("idempotencyKey must contain between 1 and 200 characters.");
  }
  if (!digestPattern.test(input.requestDigest)) {
    fail("requestDigest must be a lowercase SHA-256 digest.");
  }
  if (
    input.changes.length < 1 ||
    input.changes.length > environmentConfigurationCatalog.length
  ) {
    fail("changes must contain an allowed number of variables.");
  }
  const names = new Set<EditableEnvironmentVariableName>();
  for (const change of input.changes) {
    const name = editableName(change.name);
    if (names.has(name)) fail("changes must not contain duplicate names.");
    names.add(name);
    if (change.entry !== null) decodeEntry(name, change.entry);
  }
}

function validateRestartInput(input: EnvironmentConfigurationRestartStoreInput): void {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail("expectedRevision must be a positive integer.");
  }
  if (
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > 200 ||
    input.idempotencyKey !== input.idempotencyKey.trim()
  ) {
    fail("idempotencyKey must contain between 1 and 200 characters.");
  }
  if (!digestPattern.test(input.requestDigest)) {
    fail("requestDigest must be a lowercase SHA-256 digest.");
  }
}

function restartReceiptResult(
  row: typeof environmentConfigurationRestartRequests.$inferSelect,
  replayed: boolean,
): EnvironmentConfigurationRestartResult {
  if (!Number.isInteger(row.configurationRevision) || row.configurationRevision < 1) {
    fail("The environment restart receipt revision is invalid.");
  }
  return {
    revision: row.configurationRevision,
    targets: [...environmentServiceRestartTargets],
    requestedAt: iso(row.createdAt),
    replayed,
  };
}

function receiptResult(
  row: typeof environmentConfigurationChanges.$inferSelect,
  replayed: boolean,
): StagedEnvironmentConfiguration {
  if (!Number.isInteger(row.resultRevision) || row.resultRevision < 1) {
    fail("The environment configuration receipt revision is invalid.");
  }
  if (row.changedNames.length < 1) {
    fail("The environment configuration receipt contains no changed names.");
  }
  const changedNames = row.changedNames.map(editableName);
  if (new Set(changedNames).size !== changedNames.length) {
    fail("The environment configuration receipt contains duplicate names.");
  }
  return {
    revision: row.resultRevision,
    changedNames,
    restartRequired: row.restartRequired,
    updatedAt: iso(row.createdAt),
    replayed,
  };
}

export class DrizzleEnvironmentConfigurationStore
  implements EnvironmentConfigurationStore
{
  constructor(private readonly database: SecondBrainDatabase) {}

  /** Trusted startup read; never expose this method through an admin capability. */
  readForRuntime(
    signal: AbortSignal = defaultSignal,
  ): Promise<EnvironmentConfigurationState> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(environmentConfiguration)
        .where(eq(environmentConfiguration.id, 1))
        .limit(1);
      signal.throwIfAborted();
      const row = rows[0];
      return row === undefined
        ? { revision: 0, entries: {}, restartRequired: false, updatedAt: null }
        : mapConfigurationRow(row);
    });
  }

  readRestartRequestForRuntime(
    signal: AbortSignal = defaultSignal,
  ): Promise<number> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          restartRequestedRevision:
            environmentConfiguration.restartRequestedRevision,
        })
        .from(environmentConfiguration)
        .where(eq(environmentConfiguration.id, 1))
        .limit(1);
      signal.throwIfAborted();
      const revision = rows[0]?.restartRequestedRevision ?? 0;
      if (!Number.isInteger(revision) || revision < 0) {
        fail("The stored environment restart revision is invalid.");
      }
      return revision;
    });
  }

  read(
    access: BrainAccessContext,
    signal: AbortSignal = defaultSignal,
  ): Promise<EnvironmentConfigurationState> {
    signal.throwIfAborted();
    return this.database.transaction(async (transaction) => {
      await authorizeBrainTransaction(transaction, access, "admin", signal);
      const rows = await transaction
        .select()
        .from(environmentConfiguration)
        .where(eq(environmentConfiguration.id, 1))
        .limit(1);
      signal.throwIfAborted();
      const row = rows[0];
      return row === undefined
        ? { revision: 0, entries: {}, restartRequired: false, updatedAt: null }
        : mapConfigurationRow(row);
    });
  }

  stage(
    access: BrainAccessContext,
    input: StageEnvironmentConfigurationStoreInput,
    signal: AbortSignal = defaultSignal,
  ): Promise<StagedEnvironmentConfiguration | null> {
    signal.throwIfAborted();
    validateStageInput(input);
    return this.database.transaction(async (transaction) => {
      const authorized = await authorizeBrainTransaction(
        transaction,
        access,
        "owner",
        signal,
      );
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('environment_configuration', 0))`,
      );
      signal.throwIfAborted();

      const receiptRows = await transaction
        .select()
        .from(environmentConfigurationChanges)
        .where(
          eq(environmentConfigurationChanges.idempotencyKey, input.idempotencyKey),
        )
        .limit(1);
      const previousReceipt = receiptRows[0];
      if (previousReceipt !== undefined) {
        if (previousReceipt.requestDigest !== input.requestDigest) {
          throw new EnvironmentConfigurationStoreContractError(
            "The idempotency key was already used with another request.",
          );
        }
        return receiptResult(previousReceipt, true);
      }

      const currentRows = await transaction
        .select()
        .from(environmentConfiguration)
        .where(eq(environmentConfiguration.id, 1))
        .for("update")
        .limit(1);
      const current = currentRows[0];
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) return null;

      const entries: Record<string, unknown> = {
        ...(current === undefined ? {} : decodeEntries(current.entries)),
      };
      const changedNames = [...input.changes]
        .map(({ name }) => name)
        .sort((left, right) => left.localeCompare(right));
      for (const change of input.changes) {
        if (change.entry === null) delete entries[change.name];
        else entries[change.name] = change.entry;
      }
      const resultRevision = input.expectedRevision + 1;
      const configurationRows =
        current === undefined
          ? await transaction
              .insert(environmentConfiguration)
              .values({
                id: 1,
                revision: resultRevision,
                entries,
                restartRequired: true,
              })
              .returning()
          : await transaction
              .update(environmentConfiguration)
              .set({
                revision: resultRevision,
                entries,
                restartRequired: true,
                updatedAt: sql`current_timestamp`,
              })
              .where(
                and(
                  eq(environmentConfiguration.id, 1),
                  eq(environmentConfiguration.revision, input.expectedRevision),
                ),
              )
              .returning();
      signal.throwIfAborted();
      const configuration = configurationRows[0];
      if (configuration === undefined) return null;

      const actorAlias = await resolveAdminAuditActorAlias(
        transaction,
        authorized,
        signal,
      );

      const receiptRowsCreated = await transaction
        .insert(environmentConfigurationChanges)
        .values({
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          expectedRevision: input.expectedRevision,
          resultRevision,
          changedNames,
          restartRequired: true,
          actorAliasId: actorAlias.actorAliasId,
        })
        .returning();
      const receipt = receiptRowsCreated[0];
      if (receipt === undefined) fail("The environment configuration receipt was not stored.");

      await appendAdminAuditEvent(
        transaction,
        actorAlias.access,
        {
          category: "administration",
          action: "environment.configuration.updated",
          outcome: "succeeded",
          targetType: "environment_configuration",
          targetId: null,
          errorCode: null,
          changedNames,
        },
        signal,
      );
      signal.throwIfAborted();
      return {
        ...receiptResult(receipt, false),
        updatedAt: iso(configuration.updatedAt),
      };
    });
  }

  requestRestart(
    access: BrainAccessContext,
    input: EnvironmentConfigurationRestartStoreInput,
    signal: AbortSignal = defaultSignal,
  ): Promise<EnvironmentConfigurationRestartResult | null> {
    signal.throwIfAborted();
    validateRestartInput(input);
    return this.database.transaction(async (transaction) => {
      const authorized = await authorizeBrainTransaction(
        transaction,
        access,
        "owner",
        signal,
      );
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('environment_configuration', 0))`,
      );
      signal.throwIfAborted();

      const receiptRows = await transaction
        .select()
        .from(environmentConfigurationRestartRequests)
        .where(
          eq(
            environmentConfigurationRestartRequests.idempotencyKey,
            input.idempotencyKey,
          ),
        )
        .limit(1);
      const previousReceipt = receiptRows[0];
      if (previousReceipt !== undefined) {
        if (previousReceipt.requestDigest !== input.requestDigest) {
          throw new EnvironmentConfigurationStoreContractError(
            "The idempotency key was already used with another request.",
          );
        }
        return restartReceiptResult(previousReceipt, true);
      }

      const currentRows = await transaction
        .select()
        .from(environmentConfiguration)
        .where(eq(environmentConfiguration.id, 1))
        .for("update")
        .limit(1);
      const current = currentRows[0];
      if (
        current === undefined ||
        current.revision !== input.expectedRevision ||
        !current.restartRequired
      ) {
        return null;
      }

      const updated = await transaction
        .update(environmentConfiguration)
        .set({
          restartRequestedRevision: current.revision,
          restartRequired: false,
        })
        .where(
          and(
            eq(environmentConfiguration.id, 1),
            eq(environmentConfiguration.revision, input.expectedRevision),
            eq(environmentConfiguration.restartRequired, true),
          ),
        )
        .returning({ revision: environmentConfiguration.revision });
      if (updated.length !== 1) return null;

      const actorAlias = await resolveAdminAuditActorAlias(
        transaction,
        authorized,
        signal,
      );
      const createdRows = await transaction
        .insert(environmentConfigurationRestartRequests)
        .values({
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          configurationRevision: current.revision,
          actorAliasId: actorAlias.actorAliasId,
        })
        .returning();
      const receipt = createdRows[0];
      if (receipt === undefined) fail("The environment restart receipt was not stored.");

      await appendAdminAuditEvent(
        transaction,
        actorAlias.access,
        {
          category: "administration",
          action: "environment.services.restart_requested",
          outcome: "succeeded",
          targetType: "environment_services",
          targetId: String(current.revision),
          errorCode: null,
        },
        signal,
      );
      signal.throwIfAborted();
      return restartReceiptResult(receipt, false);
    });
  }
}
