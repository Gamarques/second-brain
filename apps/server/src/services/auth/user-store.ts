import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { SecondBrainDatabase } from "@second-brain/engine/database/client";
import type { EmbeddingProvider } from "@second-brain/engine/domain";
import { adminAuditActorAliases } from "@second-brain/engine/database/schema/admin";
import { automationSettings } from "@second-brain/engine/database/schema/automation";
import {
  accounts,
  oauthArtifacts,
  oauthSettings,
} from "@second-brain/engine/database/schema/identity";
import {
  decisions,
  knowledgeBases,
  knowledgeDocumentRevisions,
  knowledgeDocuments,
  memories,
  people,
  projects,
  reminders,
  taskLists,
  tasks,
} from "@second-brain/engine/database/schema/content";
import { brainHandoffs } from "@second-brain/engine/database/schema/context";
import { ingestReviews, ingestSources } from "@second-brain/engine/database/schema/ingestion";
import {
  activities,
  activityEvents,
  goals,
  mutationReceipts,
  priorityPlanVersions,
  priorityPlans,
  taskRelations,
} from "@second-brain/engine/database/schema/temporal";
import {
  embeddingProviderFingerprint,
  type EmbeddingProviderFingerprint,
  provisionInitialEmbeddingSpacesInTransaction,
} from "@second-brain/engine/database/stores/embedding-space-store";
import type { SecondBrainTransaction } from "@second-brain/engine/database/stores/database";
import { hashPassword, verifyPassword } from "./password.js";

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const maximumFailures = 5;
const lockMinutes = 15;
const bootstrapSetting = "account_bootstrap";
const dummyHash = hashPassword("not-a-real-user-password");
const oauthAccountRowSchema = z.object({
  id: z.uuid(),
  email: emailSchema,
});
const authenticationRowSchema = oauthAccountRowSchema.extend({
  passwordHash: z.string().min(1).max(10_000),
  status: z.enum(["active", "disabled", "deleting"]),
  failedLoginCount: z.number().int().nonnegative(),
  lockedUntil: z.date().nullable(),
});
// States written before the single-brain simplification carry an extra tenant
// key; parsing strips it, so legacy bootstrap rows stay valid.
const bootstrapStateSchema = z.object({
  version: z.literal(1),
  status: z.literal("complete"),
  accountId: z.uuid(),
});

function erasureDigest(): string {
  return randomBytes(32).toString("hex");
}

function erasureTraceId(): string {
  return `erased:${randomUUID()}`;
}

/** Every table whose historical actor attribution must be pseudonymized on erasure. */
export const accountAttributionTables = [
  projects,
  people,
  taskLists,
  tasks,
  reminders,
  memories,
  decisions,
  knowledgeBases,
  knowledgeDocuments,
  knowledgeDocumentRevisions,
  ingestSources,
  ingestReviews,
  activityEvents,
  goals,
  taskRelations,
  activities,
  priorityPlans,
  priorityPlanVersions,
  brainHandoffs,
] as const;

export interface OAuthAccount {
  readonly id: string;
  readonly email: string;
}

export class OAuthUserStore {
  constructor(private readonly database: SecondBrainDatabase) {}

  async createBootstrapAccount(
    emailInput: string,
    password: string,
    embeddingProvider: Pick<
      EmbeddingProvider,
      "provider" | "model" | "modelRevision" | "dimensions"
    >,
    signal: AbortSignal,
  ): Promise<OAuthAccount> {
    signal.throwIfAborted();
    const email = emailSchema.parse(emailInput);
    const passwordHash = await hashPassword(password);
    const fingerprint = embeddingProviderFingerprint(embeddingProvider);
    signal.throwIfAborted();

    return this.database.transaction(async (transaction) => {
      const claimed = await transaction
        .insert(oauthSettings)
        .values({
          key: bootstrapSetting,
          value: { version: 1, status: "initializing" },
        })
        .onConflictDoNothing({ target: oauthSettings.key })
        .returning({ key: oauthSettings.key });
      if (claimed.length !== 1) {
        return this.replayBootstrap(
          transaction,
          email,
          password,
          fingerprint,
          signal,
        );
      }

      const existing = await transaction
        .select({ id: accounts.id })
        .from(accounts)
        .limit(1);
      if (existing.length !== 0) {
        throw new Error("The database already contains an account.");
      }

      const insertedAccounts = await transaction
        .insert(accounts)
        .values({ email, passwordHash, role: "owner" })
        .onConflictDoNothing()
        .returning({ id: accounts.id, email: accounts.email });
      const account = insertedAccounts[0];
      if (account === undefined) {
        throw new Error("An account with this email already exists.");
      }

      await transaction
        .insert(automationSettings)
        .values({ timeZone: "UTC" })
        .onConflictDoNothing({ target: automationSettings.id });
      await provisionInitialEmbeddingSpacesInTransaction(
        transaction,
        fingerprint,
        signal,
      );

      const finalized = await transaction
        .update(oauthSettings)
        .set({
          value: {
            version: 1,
            status: "complete",
            accountId: account.id,
          },
          updatedAt: new Date(),
        })
        .where(eq(oauthSettings.key, bootstrapSetting))
        .returning({ key: oauthSettings.key });
      if (finalized.length !== 1) {
        throw new Error("The bootstrap state could not be finalized.");
      }
      signal.throwIfAborted();
      return account;
    });
  }

  private async replayBootstrap(
    transaction: SecondBrainTransaction,
    email: string,
    password: string,
    fingerprint: EmbeddingProviderFingerprint,
    signal: AbortSignal,
  ): Promise<OAuthAccount> {
    const settings = await transaction
      .select({ value: oauthSettings.value })
      .from(oauthSettings)
      .where(eq(oauthSettings.key, bootstrapSetting))
      .limit(2)
      .for("update");
    if (settings.length !== 1) {
      throw new Error("The bootstrap state is invalid.");
    }
    const state = bootstrapStateSchema.safeParse(settings[0]!.value);
    if (!state.success) {
      throw new Error("The bootstrap state is invalid.");
    }

    const rows = await transaction
      .select({
        id: accounts.id,
        email: accounts.email,
        passwordHash: accounts.passwordHash,
      })
      .from(accounts)
      .innerJoin(automationSettings, eq(automationSettings.id, 1))
      .where(
        and(
          eq(accounts.id, state.data.accountId),
          eq(accounts.email, email),
          eq(accounts.status, "active"),
          eq(accounts.role, "owner"),
        ),
      )
      .limit(2);
    if (
      rows.length !== 1 ||
      !(await verifyPassword(password, rows[0]!.passwordHash))
    ) {
      throw new Error("The bootstrap state does not match this request.");
    }
    await provisionInitialEmbeddingSpacesInTransaction(
      transaction,
      fingerprint,
      signal,
    );
    signal.throwIfAborted();
    return {
      id: rows[0]!.id,
      email: rows[0]!.email,
    };
  }

  async findAccount(id: string): Promise<OAuthAccount | null> {
    const rows = await this.database
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.status, "active")))
      .limit(1);
    if (rows[0] === undefined) return null;
    const decoded = oauthAccountRowSchema.safeParse(rows[0]);
    if (!decoded.success) {
      throw new Error("The stored OAuth account is invalid.");
    }
    return decoded.data;
  }

  async authenticate(
    emailInput: string,
    password: string,
  ): Promise<OAuthAccount | null> {
    const email = emailInput.trim().toLowerCase();
    const rows = await this.database
      .select({
        id: accounts.id,
        email: accounts.email,
        passwordHash: accounts.passwordHash,
        status: accounts.status,
        failedLoginCount: accounts.failedLoginCount,
        lockedUntil: accounts.lockedUntil,
      })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);
    if (rows[0] === undefined) {
      await verifyPassword(password, await dummyHash);
      return null;
    }
    const decoded = authenticationRowSchema.safeParse(rows[0]);
    if (!decoded.success) {
      throw new Error("The stored OAuth account is invalid.");
    }
    const account = decoded.data;

    const valid = await verifyPassword(password, account.passwordHash);
    const locked =
      account.lockedUntil !== null &&
      account.lockedUntil.getTime() > Date.now();
    if (!valid || account.status !== "active" || locked) {
      if (account.status === "active" && !locked) {
        await this.database
          .update(accounts)
          .set({
            failedLoginCount: sql`${accounts.failedLoginCount} + 1`,
            lockedUntil: sql`case
              when ${accounts.failedLoginCount} + 1 >= ${maximumFailures}
                then now() + (${lockMinutes} * interval '1 minute')
              else ${accounts.lockedUntil}
            end`,
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, account.id));
      }
      return null;
    }

    const authenticated = await this.database
      .update(accounts)
      .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(
        and(
          eq(accounts.id, account.id),
          eq(accounts.status, "active"),
          or(
            isNull(accounts.lockedUntil),
            sql`${accounts.lockedUntil} <= now()`,
          ),
        ),
      )
      .returning({ id: accounts.id, email: accounts.email });
    return authenticated[0] ?? null;
  }

  async eraseAccount(accountId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const deleting = await transaction
        .update(accounts)
        .set({ status: "deleting", updatedAt: new Date() })
        .where(eq(accounts.id, accountId))
        .returning({ id: accounts.id });
      if (deleting.length !== 1) return false;

      const attributedEvents = await transaction
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(eq(activityEvents.actorAccountId, accountId));
      for (const event of attributedEvents) {
        const digest = erasureDigest();
        const receipts = await transaction
          .select({ id: mutationReceipts.id })
          .from(mutationReceipts)
          .where(eq(mutationReceipts.activityEventId, event.id));
        for (const receipt of receipts) {
          await transaction
            .update(mutationReceipts)
            .set({
              requestDigest: digest,
              idempotencyKey: erasureTraceId(),
            })
            .where(eq(mutationReceipts.id, receipt.id));
        }
        await transaction
          .update(activityEvents)
          .set({
            actorAccountId: null,
            actorClientId: null,
            requestId: erasureTraceId(),
            correlationId: null,
            causationId: null,
            dreamingRunId: null,
            requestDigest: digest,
            contentHash: erasureDigest(),
            idempotencyKey: erasureTraceId(),
            redactedAt: new Date(),
          })
          .where(
            and(
              eq(activityEvents.id, event.id),
              eq(activityEvents.actorAccountId, accountId),
            ),
          );
      }

      const sourceTraces = await transaction
        .select({ id: ingestSources.id })
        .from(ingestSources)
        .where(eq(ingestSources.actorAccountId, accountId));
      for (const trace of sourceTraces) {
        await transaction
          .update(ingestSources)
          .set({
            requestId: erasureTraceId(),
            correlationId: null,
            causationId: null,
            dreamingRunId: null,
          })
          .where(
            and(
              eq(ingestSources.id, trace.id),
              eq(ingestSources.actorAccountId, accountId),
            ),
          );
      }
      const reviewTraces = await transaction
        .select({ id: ingestReviews.id })
        .from(ingestReviews)
        .where(eq(ingestReviews.actorAccountId, accountId));
      for (const trace of reviewTraces) {
        await transaction
          .update(ingestReviews)
          .set({
            requestId: erasureTraceId(),
            correlationId: null,
            causationId: null,
            dreamingRunId: null,
          })
          .where(
            and(
              eq(ingestReviews.id, trace.id),
              eq(ingestReviews.actorAccountId, accountId),
            ),
          );
      }
      const handoffTraces = await transaction
        .select({ id: brainHandoffs.id })
        .from(brainHandoffs)
        .where(eq(brainHandoffs.actorAccountId, accountId));
      for (const trace of handoffTraces) {
        await transaction
          .update(brainHandoffs)
          .set({
            requestId: erasureTraceId(),
            correlationId: null,
            causationId: null,
            dreamingRunId: null,
          })
          .where(
            and(
              eq(brainHandoffs.id, trace.id),
              eq(brainHandoffs.actorAccountId, accountId),
            ),
          );
      }

      for (const table of accountAttributionTables) {
        await transaction
          .update(table)
          .set({ actorAccountId: null, actorClientId: null })
          .where(eq(table.actorAccountId, accountId));
      }

      const ownedArtifactRows = await transaction
        .select({ grantId: oauthArtifacts.grantId })
        .from(oauthArtifacts)
        .where(eq(oauthArtifacts.accountId, accountId));
      const grantIds = [
        ...new Set(
          ownedArtifactRows.flatMap((row) =>
            row.grantId === null ? [] : [row.grantId],
          ),
        ),
      ];
      const artifactOwnership =
        grantIds.length === 0
          ? eq(oauthArtifacts.accountId, accountId)
          : or(
              eq(oauthArtifacts.accountId, accountId),
              inArray(oauthArtifacts.grantId, grantIds),
            );
      await transaction.delete(oauthArtifacts).where(artifactOwnership);

      const bootstrapRows = await transaction
        .select({ value: oauthSettings.value })
        .from(oauthSettings)
        .where(eq(oauthSettings.key, bootstrapSetting))
        .limit(2)
        .for("update");
      if (bootstrapRows.length > 1) {
        throw new Error("The bootstrap state is invalid.");
      }
      const bootstrapState =
        bootstrapRows[0] === undefined
          ? null
          : bootstrapStateSchema.safeParse(bootstrapRows[0].value);
      if (bootstrapState !== null && !bootstrapState.success) {
        throw new Error("The bootstrap state is invalid.");
      }
      const erasesBootstrapOwner =
        bootstrapState?.success === true &&
        bootstrapState.data.accountId === accountId;

      // Audit events remain immutable. Removing this mutable mapping severs
      // the link from their stable pseudonym to the erased account.
      await transaction
        .update(adminAuditActorAliases)
        .set({ accountId: null })
        .where(eq(adminAuditActorAliases.accountId, accountId));

      const deleted = await transaction
        .delete(accounts)
        .where(eq(accounts.id, accountId))
        .returning({ id: accounts.id });
      if (deleted.length !== 1) return false;

      if (erasesBootstrapOwner) {
        const remainingAccounts = await transaction
          .select({ id: accounts.id })
          .from(accounts)
          .limit(1);
        if (remainingAccounts.length === 0) {
          await transaction
            .delete(oauthSettings)
            .where(eq(oauthSettings.key, bootstrapSetting));
        } else {
          await transaction
            .update(oauthSettings)
            .set({
              value: { version: 1, status: "erased" },
              updatedAt: new Date(),
            })
            .where(eq(oauthSettings.key, bootstrapSetting));
        }
      }
      return true;
    });
  }
}
