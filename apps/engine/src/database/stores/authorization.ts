import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { brainRoles } from "../../domain.js";
import type {
  BrainAccessContext,
  BrainRole,
  InteractiveActorProvenance,
} from "../../domain.js";
import { accounts } from "../schema/identity.js";
import type { SecondBrainTransaction } from "./database.js";

const roleRank: Readonly<Record<BrainRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};
const lockedAccessRowsSchema = z
  .array(z.object({ role: z.enum(brainRoles) }))
  .max(2);

export class BrainAuthorizationError extends Error {
  readonly code = "BRAIN_ACCESS_DENIED";

  constructor() {
    super("Brain access was denied.");
    this.name = "BrainAuthorizationError";
  }
}

function deny(): never {
  throw new BrainAuthorizationError();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function interactiveActorIsValid(
  actor: InteractiveActorProvenance,
  accountId: string,
): boolean {
  const interactiveSource =
    actor.source === "direct" || actor.source === "mcp_http";
  const kindIsValid =
    (actor.kind === "account" && actor.clientId === null) ||
    (actor.kind === "oauth_client" &&
      actor.source === "mcp_http" &&
      typeof actor.clientId === "string" &&
      actor.clientId.trim() !== "" &&
      actor.clientId.length <= 500);
  return (
    actor.accountId === accountId &&
    actor.requestId.trim() !== "" &&
    actor.requestId.length <= 500 &&
    actor.causationId === null &&
    actor.dreamingRunId === null &&
    (actor.correlationId === null ||
      (actor.correlationId.trim() !== "" &&
        actor.correlationId.length <= 500)) &&
    interactiveSource &&
    kindIsValid
  );
}

export function validateBrainAccessContext(access: BrainAccessContext): void {
  if (
    !isUuid(access.accountId) ||
    !interactiveActorIsValid(access.actor, access.accountId) ||
    !Object.hasOwn(roleRank, access.role)
  ) {
    deny();
  }
}

export function rolesAtLeast(requiredRole: BrainRole): readonly BrainRole[] {
  if (!Object.hasOwn(roleRank, requiredRole)) deny();
  const minimum = roleRank[requiredRole];
  return brainRoles.filter((role) => roleRank[role] >= minimum);
}

/**
 * Locks the live account inside the caller's transaction. The lock serializes
 * account disablement and role changes with the authorized operation that
 * follows in that transaction.
 */
export async function authorizeBrainTransaction(
  transaction: SecondBrainTransaction,
  access: BrainAccessContext,
  requiredRole: BrainRole,
  signal: AbortSignal,
): Promise<BrainAccessContext> {
  signal.throwIfAborted();
  validateBrainAccessContext(access);
  const allowedRoles = rolesAtLeast(requiredRole);

  await transaction.execute(
    sql`select
      set_config('statement_timeout', '10000', true),
      set_config('lock_timeout', '3000', true)`,
  );
  const result = await transaction
    .select({ role: accounts.role })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, access.accountId),
        eq(accounts.status, "active"),
        inArray(accounts.role, allowedRoles),
      ),
    )
    .limit(2)
    .for("share");
  signal.throwIfAborted();

  const decoded = lockedAccessRowsSchema.safeParse(result);
  if (!decoded.success || decoded.data.length !== 1) deny();
  return { ...access, role: decoded.data[0]!.role };
}
