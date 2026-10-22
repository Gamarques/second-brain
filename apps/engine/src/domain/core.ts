export const brainRoles = ["viewer", "editor", "admin", "owner"] as const;
export type BrainRole = (typeof brainRoles)[number];

export const actorKinds = [
  "account",
  "oauth_client",
  "import",
  "dreaming",
  "system",
] as const;
export type ActorKind = (typeof actorKinds)[number];

export const mutationSources = [
  "direct",
  "mcp_http",
  "automation",
  "import",
] as const;
export type MutationSource = (typeof mutationSources)[number];

interface ActorSource {
  readonly source: MutationSource;
}

/** Historical attribution may be pseudonymized after an account is deleted. */
export type ActorAttribution = ActorSource &
  (
    | {
        readonly kind: "account";
        readonly accountId: string | null;
        readonly clientId: null;
      }
    | {
        readonly kind: "oauth_client";
        readonly accountId: string;
        readonly clientId: string;
      }
    | {
        readonly kind: "oauth_client";
        readonly accountId: null;
        readonly clientId: null;
      }
    | {
        readonly kind: "import";
        readonly accountId: string | null;
        readonly clientId: null;
      }
    | {
        readonly kind: "dreaming" | "system";
        readonly accountId: null;
        readonly clientId: null;
      }
  );

interface RequestProvenance {
  readonly requestId: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly dreamingRunId: string | null;
}

/** Interactive/import writes have a live account; internal actors never impersonate one. */
export type ActorProvenance = ActorSource &
  (
    | {
        readonly kind: "account";
        readonly accountId: string;
        readonly clientId: null;
        readonly dreamingRunId: null;
      }
    | {
        readonly kind: "oauth_client";
        readonly accountId: string;
        readonly clientId: string;
        readonly dreamingRunId: null;
      }
    | {
        readonly kind: "import";
        readonly accountId: string;
        readonly clientId: null;
        readonly dreamingRunId: null;
      }
    | {
        readonly kind: "dreaming";
        readonly accountId: null;
        readonly clientId: null;
        readonly dreamingRunId: string;
        readonly causationId: string;
      }
    | {
        readonly kind: "system";
        readonly accountId: null;
        readonly clientId: null;
        readonly dreamingRunId: null;
      }
  ) &
  RequestProvenance;

export type InteractiveActorProvenance = Extract<
  ActorProvenance,
  { readonly kind: "account" | "oauth_client" }
>;

export interface BrainAccessContext {
  readonly accountId: string;
  readonly role: BrainRole;
  readonly actor: InteractiveActorProvenance;
  /** True only when a private browser-admin invocation was mapped to DB provenance. */
  readonly administrativeChannel?: true;
}

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * The engine serves one brain. Capability inputs carry no brain selection, so
 * resolution depends only on the authenticated principal and the role the
 * capability demands.
 */
export interface BrainAccessRequest {
  readonly principal: AuthenticatedPrincipal;
  readonly requiredRole: BrainRole;
  readonly source: MutationSource;
  readonly requestId: string;
  readonly correlationId: string | null;
}

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CursorPosition {
  readonly ts: string;
  readonly id: string;
}

export interface TemporalCoverage {
  readonly completeFrom: string | null;
  readonly requestedAsOf: string | null;
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: CursorPosition | null;
}

export interface TemporalPage<T> extends Page<T> {
  readonly coverage: TemporalCoverage;
}

export interface VersionPrecondition {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface ContentEmbedding {
  readonly spaceId: string;
  readonly contentHash: string;
  readonly vector: readonly number[];
}

export const embeddingInputTypes = ["search_document", "search_query"] as const;
export type EmbeddingInputType = (typeof embeddingInputTypes)[number];

export const embeddingEntityTypes = [
  "memory",
  "decision",
  "knowledge_chunk",
  "insight",
] as const;
export type EmbeddingEntityType = (typeof embeddingEntityTypes)[number];

export const embeddingMetrics = ["cosine"] as const;
export type EmbeddingMetric = (typeof embeddingMetrics)[number];

export const embeddingSpaceStatuses = [
  "preparing",
  "active",
  "retired",
  "failed",
] as const;
export type EmbeddingSpaceStatus = (typeof embeddingSpaceStatuses)[number];

export interface EmbeddingSpace {
  readonly id: string;
  readonly entityType: EmbeddingEntityType;
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly recipeVersion: string;
  readonly dimensions: number;
  readonly metric: EmbeddingMetric;
  readonly status: EmbeddingSpaceStatus;
  readonly createdAt: string;
  readonly promotedAt: string | null;
  readonly retiredAt: string | null;
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly dimensions: number;
  embed(
    texts: readonly string[],
    signal: AbortSignal,
    inputType: EmbeddingInputType,
  ): Promise<readonly (readonly number[])[]>;
}
