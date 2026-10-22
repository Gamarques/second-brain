import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { brainRoles } from "../../domain.js";
import type {
  BrainAccessContext,
  BrainAccessRequest,
  BrainRole,
  InteractiveActorProvenance,
} from "../../domain.js";
import type { BrainAccessStore } from "../../domain.js";
import { accounts } from "../schema/identity.js";
import { automationSettings } from "../schema/automation.js";
import {
  authorizeBrainTransaction,
  validateBrainAccessContext,
} from "./authorization.js";
import type { SecondBrainDatabase } from "./database.js";

const roleRank: Readonly<Record<BrainRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export type AccessDatabase = SecondBrainDatabase;

export class BrainAccessDeniedError extends Error {
  readonly code = "BRAIN_ACCESS_DENIED";

  constructor() {
    super("Brain access was denied.");
    this.name = "BrainAccessDeniedError";
  }
}

function deny(): never {
  throw new BrainAccessDeniedError();
}

function hasRequiredRole(actual: BrainRole, required: BrainRole): boolean {
  return roleRank[actual] >= roleRank[required];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function liveClientId(request: BrainAccessRequest): string | null {
  const value = request.principal.attributes?.clientId;
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
    deny();
  }
  return value;
}

function actorFor(request: BrainAccessRequest): InteractiveActorProvenance {
  const clientId = liveClientId(request);
  const common = {
    accountId: request.principal.id,
    source: request.source,
    requestId: request.requestId,
    correlationId: request.correlationId,
    causationId: null,
    dreamingRunId: null,
  } as const;

  if (request.source === "mcp_http" && clientId !== null) {
    return { ...common, kind: "oauth_client", clientId };
  }
  if (request.source === "import" || request.source === "automation") {
    deny();
  }
  return { ...common, kind: "account", clientId: null };
}

const accessRowsSchema = z
  .array(z.object({ role: z.enum(brainRoles) }))
  .max(2);
const timeZoneRowSchema = z.object({
  timeZone: z.string().min(1).max(200),
});

function decodeAccessRows(value: unknown): readonly { readonly role: BrainRole }[] {
  const decoded = accessRowsSchema.safeParse(value);
  if (!decoded.success) deny();
  return decoded.data;
}

export class DrizzleBrainAccessStore implements BrainAccessStore {
  constructor(private readonly database: AccessDatabase) {}

  async resolveAccess(
    request: BrainAccessRequest,
    signal: AbortSignal,
  ): Promise<BrainAccessContext> {
    signal.throwIfAborted();
    if (
      !isUuid(request.principal.id) ||
      request.requestId.trim() === "" ||
      request.requestId.length > 500 ||
      (request.correlationId !== null &&
        (request.correlationId.trim() === "" || request.correlationId.length > 500)) ||
      !Object.hasOwn(roleRank, request.requiredRole)
    ) {
      deny();
    }
    const actor = actorFor(request);

    const result = await this.accountRole(request.principal.id);
    const rows = decodeAccessRows(result);
    signal.throwIfAborted();
    if (rows.length !== 1) deny();
    const row = rows[0]!;
    if (!hasRequiredRole(row.role, request.requiredRole)) deny();

    return {
      accountId: request.principal.id,
      role: row.role,
      actor,
    };
  }

  async revalidateAccess(
    access: BrainAccessContext,
    requiredRole: BrainRole,
    signal: AbortSignal,
  ): Promise<BrainAccessContext> {
    signal.throwIfAborted();
    try {
      validateBrainAccessContext(access);
    } catch {
      deny();
    }
    if (!Object.hasOwn(roleRank, requiredRole)) deny();
    try {
      return await this.database.transaction((transaction) =>
        authorizeBrainTransaction(transaction, access, requiredRole, signal),
      );
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof BrainAccessDeniedError) throw error;
      deny();
    }
  }

  async getTimeZone(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    try {
      validateBrainAccessContext(access);
    } catch {
      deny();
    }
    const rows = await this.database
      .select({ timeZone: automationSettings.timeZone })
      .from(automationSettings)
      .limit(1);
    signal.throwIfAborted();
    const decoded = timeZoneRowSchema.safeParse(rows[0]);
    if (!decoded.success) deny();
    return decoded.data.timeZone;
  }

  /**
   * Resolves the account's live role. `resolveAccess` denies unless this
   * returns exactly one active-account row.
   */
  private accountRole(accountId: string): Promise<{ role: BrainRole }[]> {
    return this.database
      .select({ role: accounts.role })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
      .limit(2);
  }
}
