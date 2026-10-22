import { describe, expect, it } from "vitest";

import type { BrainAccessContext } from "../src/domain.js";
import {
  BrainAuthorizationError,
  rolesAtLeast,
  validateBrainAccessContext,
} from "../src/database/stores/authorization.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000002";

function validAccess(): BrainAccessContext {
  return {
    accountId,
    role: "editor",
    actor: {
      kind: "account",
      accountId,
      clientId: null,
      source: "direct",
      requestId: "request-1",
      correlationId: null,
      causationId: null,
      dreamingRunId: null,
    },
  };
}

describe("transactional brain authorization", () => {
  it("maps each minimum role to the exact database predicate", () => {
    expect(rolesAtLeast("viewer")).toEqual(["viewer", "editor", "admin", "owner"]);
    expect(rolesAtLeast("editor")).toEqual(["editor", "admin", "owner"]);
    expect(rolesAtLeast("admin")).toEqual(["admin", "owner"]);
    expect(rolesAtLeast("owner")).toEqual(["owner"]);
  });

  it("accepts coherent interactive account and OAuth provenance", () => {
    expect(() => validateBrainAccessContext(validAccess())).not.toThrow();
    expect(() =>
      validateBrainAccessContext({
        ...validAccess(),
        actor: {
          ...validAccess().actor,
          kind: "oauth_client",
          clientId: "cursor",
          source: "mcp_http",
        },
      }),
    ).not.toThrow();
  });

  it("fails closed before querying for mismatched or malformed access", () => {
    expect(() =>
      validateBrainAccessContext({
        ...validAccess(),
        accountId: "not-a-uuid",
      }),
    ).toThrow(BrainAuthorizationError);
    expect(() =>
      validateBrainAccessContext({
        ...validAccess(),
        actor: { ...validAccess().actor, accountId: otherAccountId },
      }),
    ).toThrow(BrainAuthorizationError);
  });
});
