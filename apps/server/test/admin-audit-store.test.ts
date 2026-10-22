import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeAdminAuditRow,
  DrizzleAdminAuditStore,
  normalizeAdminAuditAppendInput,
} from "../src/services/shared/audit-store.js";
import { adminBoundaryAuditRow } from "../src/services/admin/audit.js";

const accountId = randomUUID();
const actorAliasId = randomUUID();
const eventId = randomUUID();
const occurredAt = new Date("2026-08-23T12:00:00.000Z");

describe("admin audit store boundaries", () => {
  it("maps configuration metadata from changed names only", () => {
    const input = normalizeAdminAuditAppendInput({
      category: "administration",
      action: "environment.configuration.updated",
      outcome: "succeeded",
      targetType: "environment_configuration",
      targetId: "1",
      errorCode: null,
      changedNames: ["OPENROUTER_API_KEY", "DREAMING_ENABLED", "DREAMING_ENABLED"],
    });

    expect(input).toEqual({
      category: "administration",
      action: "environment.configuration.updated",
      outcome: "succeeded",
      targetType: "environment_configuration",
      targetId: "1",
      errorCode: null,
      changedNames: ["DREAMING_ENABLED", "OPENROUTER_API_KEY"],
      metadata: {
        changedNames: ["DREAMING_ENABLED", "OPENROUTER_API_KEY"],
      },
    });
    expect(JSON.stringify(input)).not.toContain("secret");
  });

  it("rejects values and extra metadata for configuration events", () => {
    expect(() =>
      normalizeAdminAuditAppendInput({
        category: "administration",
        action: "environment.configuration.updated",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: "1",
        errorCode: null,
        changedNames: ["OPENROUTER_API_KEY"],
        metadata: { OPENROUTER_API_KEY: "secret-value" },
      }),
    ).toThrow("Configuration audit metadata must contain changed names only.");
    expect(() =>
      normalizeAdminAuditAppendInput({
        category: "administration",
        action: "environment.configuration.updated",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: "1",
        errorCode: null,
        changedNames: [],
      }),
    ).toThrow("changedNames must contain between 1 and 100 names");
  });

  it("decodes append-only rows and rejects inconsistent configuration metadata", () => {
    expect(
      decodeAdminAuditRow({
        id: eventId,
        category: "administration",
        action: "environment.configuration.updated",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: "1",
        actorAliasId,
        actorAccountId: accountId,
        actorRole: "admin",
        requestId: "request-1",
        errorCode: null,
        metadata: { changedNames: ["DREAMING_ENABLED"] },
        changedNames: ["DREAMING_ENABLED"],
        occurredAt,
      }),
    ).toEqual({
      id: eventId,
      category: "administration",
      action: "environment.configuration.updated",
      outcome: "succeeded",
      targetType: "environment_configuration",
      targetId: "1",
      actorAccountId: accountId,
      actorRole: "admin",
      requestId: "request-1",
      errorCode: null,
      metadata: { changedNames: ["DREAMING_ENABLED"] },
      occurredAt: occurredAt.toISOString(),
    });

    expect(() =>
      decodeAdminAuditRow({
        id: eventId,
        category: "administration",
        action: "environment.configuration.updated",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: "1",
        actorAliasId,
        actorAccountId: accountId,
        actorRole: "admin",
        requestId: "request-1",
        errorCode: null,
        metadata: { changedNames: ["DREAMING_ENABLED"], value: true },
        changedNames: ["DREAMING_ENABLED"],
        occurredAt,
      }),
    ).toThrow("configuration metadata is inconsistent");

    expect(() =>
      decodeAdminAuditRow({
        id: eventId,
        category: "administration",
        action: "environment.configuration.updated",
        outcome: "succeeded",
        targetType: "environment_configuration",
        targetId: "1",
        actorAccountId: accountId,
        actorRole: "admin",
        requestId: "request-1",
        errorCode: null,
        metadata: { changedNames: ["DREAMING_ENABLED"] },
        changedNames: ["DREAMING_ENABLED"],
        occurredAt,
      }),
    ).toThrow("row validation failed");
  });

  it("maps closed boundary events without request payloads", () => {
    const row = adminBoundaryAuditRow({
      kind: "request_outcome",
      actor: null,
      category: "authentication",
      action: "authentication.session",
      outcome: "denied",
      method: "GET",
      requestId: "auth-request-1",
      errorCode: "ADMIN_SESSION_DENIED",
    });
    expect(row).toEqual({
      actor: null,
      category: "authentication",
      action: "authentication.session",
      outcome: "denied",
      targetType: null,
      targetId: null,
      requestId: "auth-request-1",
      errorCode: "ADMIN_SESSION_DENIED",
      metadata: { method: "GET" },
    });
    expect(JSON.stringify(row)).not.toContain("email");
    expect(JSON.stringify(row)).not.toContain("password");
  });

  it("decodes anonymous immutable security events", () => {
    expect(
      decodeAdminAuditRow({
        id: eventId,
        category: "authentication",
        action: "authentication.oauth_sign_in",
        outcome: "denied",
        targetType: "admin_session",
        targetId: null,
        actorAliasId: null,
        actorAccountId: null,
        actorRole: null,
        requestId: "anonymous-request-1",
        errorCode: "OAUTH_CREDENTIALS_DENIED",
        metadata: {},
        changedNames: [],
        occurredAt,
      }),
    ).toMatchObject({
      actorAccountId: null,
      actorRole: null,
      requestId: "anonymous-request-1",
    });
  });

  it("keeps the public store append-only without update or delete operations", () => {
    const prototype = DrizzleAdminAuditStore.prototype as unknown as Record<
      string,
      unknown
    >;

    expect(prototype.listAuditEvents).toBeTypeOf("function");
    expect(prototype.appendAuditEvent).toBeTypeOf("function");
    expect(prototype.recordOAuthSignInOutcome).toBeTypeOf("function");
    expect(prototype.updateAuditEvent).toBeUndefined();
    expect(prototype.deleteAuditEvent).toBeUndefined();
  });
});
