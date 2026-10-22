import type { ExecutionContext, Principal } from "@invokta/core";

import type {
  AuthenticatedPrincipal,
  BrainAccessContext,
  BrainAccessStore,
  BrainRole,
  MutationSource,
} from "../domain.js";

const sourceMap = {
  direct: "direct",
  "mcp-http": "mcp_http",
} as const satisfies Partial<Readonly<Record<ExecutionContext["source"], MutationSource>>>;

const roleRank: Readonly<Record<BrainRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export interface RequireBrainAccessOptions {
  readonly requiredRole: BrainRole;
}

export class CapabilityAccessDeniedError extends Error {
  readonly code = "BRAIN_ACCESS_DENIED";

  constructor(cause?: unknown) {
    super("Brain access was denied.", { cause });
    this.name = "CapabilityAccessDeniedError";
  }
}

function deny(cause?: unknown): never {
  throw new CapabilityAccessDeniedError(cause);
}

function sanitizedPrincipal(principal: Principal | null): {
  readonly principal: AuthenticatedPrincipal;
  readonly clientId: string | null;
} {
  if (principal === null) deny();

  try {
    if (principal.id === "" || principal.id.trim() !== principal.id) deny();
    const clientIdValue = principal.attributes?.clientId;
    if (clientIdValue === undefined) {
      return { principal: { id: principal.id }, clientId: null };
    }
    if (
      typeof clientIdValue !== "string" ||
      clientIdValue.trim() === "" ||
      clientIdValue.length > 500
    ) {
      deny();
    }
    return {
      principal: { id: principal.id, attributes: { clientId: clientIdValue } },
      clientId: clientIdValue,
    };
  } catch (cause) {
    if (cause instanceof CapabilityAccessDeniedError) throw cause;
    return deny(cause);
  }
}

function hasRequiredRole(actual: BrainRole, required: BrainRole): boolean {
  return roleRank[actual] >= roleRank[required];
}

function mutationSourceFor(source: ExecutionContext["source"]): MutationSource {
  const mapped = (sourceMap as Readonly<Record<string, MutationSource | undefined>>)[source];
  if (mapped === undefined) deny();
  return mapped;
}

function isValidResolvedAccess(
  access: BrainAccessContext,
  expected: {
    readonly accountId: string;
    readonly clientId: string | null;
    readonly requiredRole: BrainRole;
    readonly requestId: string;
    readonly source: MutationSource;
  },
): boolean {
  try {
    if (
      access.accountId !== expected.accountId ||
      !Object.hasOwn(roleRank, access.role) ||
      !hasRequiredRole(access.role, expected.requiredRole)
    ) {
      return false;
    }

    const actor = access.actor;
    if (
      actor.accountId !== expected.accountId ||
      actor.source !== expected.source ||
      actor.requestId !== expected.requestId ||
      actor.correlationId !== null ||
      actor.causationId !== null ||
      actor.dreamingRunId !== null
    ) {
      return false;
    }

    if (expected.source === "mcp_http" && expected.clientId !== null) {
      return actor.kind === "oauth_client" && actor.clientId === expected.clientId;
    }
    return actor.kind === "account" && actor.clientId === null;
  } catch {
    return false;
  }
}

/**
 * Resolves one authenticated capability invocation to the account's brain
 * role. Principal attributes provide attribution only; the store is the sole
 * authority for roles.
 */
export async function requireBrainAccess(
  accessStore: BrainAccessStore,
  context: ExecutionContext,
  options: RequireBrainAccessOptions,
): Promise<BrainAccessContext> {
  context.signal.throwIfAborted();

  let authenticated: ReturnType<typeof sanitizedPrincipal>;
  let source: MutationSource;
  const administrativeChannel = String(context.source) === "admin";
  try {
    authenticated = sanitizedPrincipal(context.principal);
    if (
      context.requestId === "" ||
      context.requestId.trim() === "" ||
      context.requestId.length > 500
    ) {
      deny();
    }
    source = administrativeChannel ? "direct" : mutationSourceFor(context.source);
  } catch (cause) {
    if (cause instanceof CapabilityAccessDeniedError) throw cause;
    return deny(cause);
  }

  const request = {
    principal: authenticated.principal,
    requiredRole: options.requiredRole,
    source,
    requestId: context.requestId,
    correlationId: null,
  } satisfies Parameters<BrainAccessStore["resolveAccess"]>[0];

  let access: BrainAccessContext;
  try {
    access = await accessStore.resolveAccess(request, context.signal);
  } catch (cause) {
    if (context.signal.aborted) context.signal.throwIfAborted();
    return deny(cause);
  }
  context.signal.throwIfAborted();

  if (
    !isValidResolvedAccess(access, {
      accountId: authenticated.principal.id,
      clientId: authenticated.clientId,
      requiredRole: options.requiredRole,
      requestId: context.requestId,
      source,
    })
  ) {
    deny();
  }
  if (administrativeChannel) return { ...access, administrativeChannel: true };
  const { administrativeChannel: _untrustedChannel, ...directAccess } = access;
  return directAccess;
}
