import { eq } from "drizzle-orm";

import type { BrainAccessContext } from "../../domain.js";
import {
  adminAuditActorAliases,
  adminAuditEvents,
} from "../schema/admin.js";
import { authorizeBrainTransaction } from "./authorization.js";
import type { SecondBrainTransaction } from "./database.js";

export interface AdministrativeDomainAuditInput {
  readonly category: "domain";
  readonly action: string;
  readonly outcome: "succeeded";
  readonly targetType: string;
  readonly targetId: string;
  readonly errorCode: null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

/**
 * Records an administrative-channel domain mutation inside its transaction.
 * Admin querying and transport-specific boundary events remain server-owned.
 */
export async function appendAdministrativeDomainAuditEvent(
  transaction: SecondBrainTransaction,
  access: BrainAccessContext,
  input: AdministrativeDomainAuditInput,
  signal: AbortSignal,
): Promise<void> {
  const authorized = await authorizeBrainTransaction(
    transaction,
    access,
    "admin",
    signal,
  );
  await transaction
    .insert(adminAuditActorAliases)
    .values({ accountId: authorized.accountId })
    .onConflictDoNothing({ target: adminAuditActorAliases.accountId });
  const aliases = await transaction
    .select({ id: adminAuditActorAliases.id })
    .from(adminAuditActorAliases)
    .where(eq(adminAuditActorAliases.accountId, authorized.accountId))
    .limit(2);
  signal.throwIfAborted();
  if (aliases.length !== 1) {
    throw new Error("Administrative audit actor resolution failed.");
  }
  const rows = await transaction
    .insert(adminAuditEvents)
    .values({
      category: input.category,
      action: boundedText(input.action, "action", 200),
      outcome: input.outcome,
      targetType: boundedText(input.targetType, "targetType", 200),
      targetId: boundedText(input.targetId, "targetId", 500),
      actorAliasId: aliases[0]!.id,
      actorRole: authorized.role,
      requestId: boundedText(authorized.actor.requestId, "requestId", 500),
      errorCode: input.errorCode,
      metadata: input.metadata,
      changedNames: [],
    })
    .returning({ id: adminAuditEvents.id });
  signal.throwIfAborted();
  if (rows.length !== 1) {
    throw new Error("Administrative audit append failed.");
  }
}
