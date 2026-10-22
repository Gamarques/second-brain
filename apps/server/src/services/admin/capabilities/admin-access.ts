import type { ExecutionContext, Principal } from "@invokta/core";

import type { BrainAccessStore, BrainRole } from "@second-brain/engine/domain";
import { requireBrainAccess } from "@second-brain/engine/capabilities/access";

export const adminExecutionSource = "admin" as const;

export function isAdminExecutionContext(context: ExecutionContext): boolean {
  return String(context.source) === adminExecutionSource;
}

export function adminChannelAccess({
  principal,
  context,
}: {
  readonly principal: Principal | null;
  readonly context: ExecutionContext;
}): boolean {
  return principal !== null && isAdminExecutionContext(context);
}

export async function requireAdminAccess(
  accessStore: BrainAccessStore,
  context: ExecutionContext,
  requiredRole: Extract<BrainRole, "admin" | "owner"> = "admin",
) {
  if (!isAdminExecutionContext(context)) {
    throw new Error(
      "This action is available only through the administrative channel.",
    );
  }
  // Invokta 0.6 does not yet type the private admin source. Once the channel
  // gate has succeeded, reuse the trusted-direct provenance supported by the
  // existing authorization store. The audit row retains the real channel.
  return requireBrainAccess(
    accessStore,
    { ...context, source: "direct" },
    { requiredRole },
  );
}
