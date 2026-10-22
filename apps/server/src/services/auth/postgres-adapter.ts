import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Adapter, AdapterPayload } from "oidc-provider";

import type { SecondBrainDatabase } from "@second-brain/engine/database/client";
import { oauthArtifacts } from "@second-brain/engine/database/schema/identity";

const maximumArtifactBytes = 1024 * 1024;
const maximumArtifactNodes = 100_000;
const maximumArtifactStringLength = 250_000;
const maximumArtifactLifetimeSeconds = 366 * 24 * 60 * 60;

function optionalString(value: unknown, maximumLength = 10_000): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : null;
}

function typedOptionalString(
  payload: AdapterPayload,
  keys: readonly string[],
  maximumLength = 10_000,
): string | null {
  const values = new Set<string>();
  for (const key of keys) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = payload[key];
    if (value === null || value === undefined) continue;
    const parsed = optionalString(value, maximumLength);
    if (parsed === null) {
      throw new Error("The OAuth artifact lookup metadata is invalid.");
    }
    values.add(parsed);
  }
  if (values.size > 1) {
    throw new Error("The OAuth artifact lookup metadata is ambiguous.");
  }
  return values.values().next().value ?? null;
}

function optionalUuid(value: unknown): string | null {
  const candidate = optionalString(value, 36);
  return candidate !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate,
    )
    ? candidate
    : null;
}

function trustedUuidCandidates(candidates: readonly unknown[]): string | null {
  const identities = new Set<string>();
  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const parsed = optionalUuid(value);
    if (parsed === null) {
      throw new Error("The OAuth artifact identity metadata is invalid.");
    }
    identities.add(parsed);
  }
  if (identities.size > 1) {
    throw new Error("The OAuth artifact identity metadata is ambiguous.");
  }
  return identities.values().next().value ?? null;
}

function objectField(value: unknown, key: string): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, key)
  ) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

const topLevelAccountModels = new Set([
  "AccessToken",
  "AuthorizationCode",
  "BackchannelAuthenticationRequest",
  "DeviceCode",
  "Grant",
  "PreAuthorizedCode",
  "RefreshToken",
  "Session",
]);

/** Only oidc-provider-owned, model-specific fields may establish account ownership. */
function accountId(model: string, payload: AdapterPayload): string | null {
  if (topLevelAccountModels.has(model)) {
    return trustedUuidCandidates([payload.accountId]);
  }
  if (model === "Interaction") {
    const login = objectField(payload.result, "login");
    return trustedUuidCandidates([
      objectField(payload.session, "accountId"),
      objectField(login, "accountId"),
    ]);
  }
  return null;
}

function clientId(payload: AdapterPayload): string | null {
  return typedOptionalString(payload, ["clientId", "client_id", "cid"], 500);
}

function isJsonValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): boolean {
  state.nodes += 1;
  if (state.nodes > maximumArtifactNodes || depth > 32) return false;
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string")
    return value.length <= maximumArtifactStringLength;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, state, depth + 1));
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(
    ([key, item]) => key.length <= 1_000 && isJsonValue(item, state, depth + 1),
  );
}

function validArtifactPayload(value: unknown): boolean {
  if (
    !isJsonValue(value, { nodes: 0 }) ||
    Array.isArray(value) ||
    value === null
  ) {
    return false;
  }
  try {
    return (
      Buffer.byteLength(JSON.stringify(value), "utf8") <= maximumArtifactBytes
    );
  } catch {
    return false;
  }
}

export function parseAdapterPayload(value: unknown): AdapterPayload {
  if (!validArtifactPayload(value)) {
    throw new Error("The stored OAuth artifact payload is invalid.");
  }
  return value as AdapterPayload;
}

export class DrizzleOidcAdapter implements Adapter {
  constructor(
    private readonly database: SecondBrainDatabase,
    private readonly model: string,
  ) {
    if (model === "" || model.length > 200) {
      throw new Error("The OAuth artifact model is invalid.");
    }
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn?: number,
  ): Promise<void> {
    if (id === "" || id.length > 10_000 || !validArtifactPayload(payload)) {
      throw new Error("The OAuth artifact payload is invalid.");
    }
    if (
      expiresIn !== undefined &&
      (!Number.isFinite(expiresIn) ||
        !Number.isInteger(expiresIn) ||
        expiresIn < 0 ||
        expiresIn > maximumArtifactLifetimeSeconds)
    ) {
      throw new Error("The OAuth artifact lifetime is invalid.");
    }
    const expiresAt =
      expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1_000);
    const values = {
      model: this.model,
      id,
      payload,
      accountId: accountId(this.model, payload),
      clientId: clientId(payload),
      grantId: typedOptionalString(payload, ["grantId"]),
      userCode: typedOptionalString(payload, ["userCode"]),
      uid: typedOptionalString(payload, ["uid"]),
      expiresAt,
      consumedAt: null,
    } as const;
    await this.database
      .insert(oauthArtifacts)
      .values(values)
      .onConflictDoUpdate({
        target: [oauthArtifacts.model, oauthArtifacts.id],
        set: {
          payload: values.payload,
          accountId: values.accountId,
          clientId: values.clientId,
          grantId: values.grantId,
          userCode: values.userCode,
          uid: values.uid,
          expiresAt: values.expiresAt,
          consumedAt: null,
        },
      });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.findBy("id", id);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findBy("userCode", userCode);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findBy("uid", uid);
  }

  async consume(id: string): Promise<void> {
    const consumed = await this.database
      .update(oauthArtifacts)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(oauthArtifacts.model, this.model),
          eq(oauthArtifacts.id, id),
          isNull(oauthArtifacts.consumedAt),
          or(
            isNull(oauthArtifacts.expiresAt),
            gt(oauthArtifacts.expiresAt, new Date()),
          ),
        ),
      )
      .returning({ id: oauthArtifacts.id });
    if (consumed.length !== 1) {
      throw new Error("The OAuth artifact is unavailable for consumption.");
    }
  }

  async destroy(id: string): Promise<void> {
    await this.database
      .delete(oauthArtifacts)
      .where(
        and(eq(oauthArtifacts.model, this.model), eq(oauthArtifacts.id, id)),
      );
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.database
      .delete(oauthArtifacts)
      .where(
        and(
          eq(oauthArtifacts.model, this.model),
          eq(oauthArtifacts.grantId, grantId),
        ),
      );
  }

  private async findBy(
    column: "id" | "userCode" | "uid",
    value: string,
  ): Promise<AdapterPayload | undefined> {
    const target = oauthArtifacts[column];
    // Expired artifacts are dead data; purge them on lookup so the store
    // never accumulates rows that every read already treats as absent.
    await this.database
      .delete(oauthArtifacts)
      .where(
        and(
          eq(oauthArtifacts.model, this.model),
          eq(target, value),
          isNotNull(oauthArtifacts.expiresAt),
          lte(oauthArtifacts.expiresAt, new Date()),
        ),
      );
    const rows = await this.database
      .select({
        payload: oauthArtifacts.payload,
        consumedAt: oauthArtifacts.consumedAt,
      })
      .from(oauthArtifacts)
      .where(
        and(
          eq(oauthArtifacts.model, this.model),
          eq(target, value),
          or(
            isNull(oauthArtifacts.expiresAt),
            gt(oauthArtifacts.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    const payload = parseAdapterPayload(row.payload);
    return row.consumedAt === null
      ? payload
      : { ...payload, consumed: Math.floor(row.consumedAt.getTime() / 1_000) };
  }
}

export function createDrizzleOidcAdapter(database: SecondBrainDatabase) {
  return (name: string): Adapter => new DrizzleOidcAdapter(database, name);
}
