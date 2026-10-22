import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decodePersonRow,
  DrizzlePersonStore,
  PersonStoreContractError,
} from "../src/database/stores/person-store.js";
import {
  decodeProjectRow,
  DrizzleProjectStore,
  ProjectStoreContractError,
} from "../src/database/stores/project-store.js";
import type { SecondBrainDatabase } from "../src/database/stores/database.js";
import type { BrainAccessContext } from "../src/domain.js";

const accountId = randomUUID();
const now = new Date("2026-08-16T12:00:00.000Z");

function access(): BrainAccessContext {
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

describe("project and person store boundaries", () => {
  it("keeps actor identity out of semantic request digest recipes", () => {
    for (const storePath of [
      new URL("../src/database/stores/project-store.ts", import.meta.url),
      new URL("../src/database/stores/person-store.ts", import.meta.url),
    ]) {
      const source = readFileSync(storePath, "utf8");
      expect(source).not.toContain("actorDigest");
      const recipes = [
        ...source.matchAll(
          /const requestDigest = digest\(\{([\s\S]*?)^\s{2,4}\}\);/gm,
        ),
      ];
      expect(recipes).toHaveLength(2);
      for (const recipe of recipes) {
        expect(recipe[1]).not.toMatch(/\b(?:actor|accountId|clientId)\b/);
      }
    }
  });

  it("decodes project dates, versions, enums, and actor attribution", () => {
    expect(
      decodeProjectRow({
        id: randomUUID(),
        name: "Launch",
        description: null,
        status: "active",
        version: 2,
        actorKind: "account",
        actorAccountId: accountId,
        actorClientId: null,
        actorSource: "direct",
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({
      name: "Launch",
      version: 2,
      createdAt: now.toISOString(),
      provenance: { kind: "account", accountId, clientId: null },
    });
  });

  it("rejects malformed project rows instead of trusting driver types", () => {
    expect(() =>
      decodeProjectRow({
        id: randomUUID(),
        name: "Launch",
        description: null,
        status: "unknown",
        version: 0,
        actorKind: "account",
        actorAccountId: accountId,
        actorClientId: "unexpected-client",
        actorSource: "direct",
        createdAt: "not-a-date",
        updatedAt: now,
      }),
    ).toThrow(ProjectStoreContractError);
  });

  it("copies person aliases and rejects partially redacted OAuth attribution", () => {
    const aliases = ["Ada"];
    const person = decodePersonRow({
      id: randomUUID(),
      name: "Ada Lovelace",
      aliases,
      notes: null,
      summary: null,
      tags: [],
      version: 1,
      actorKind: "account",
      actorAccountId: accountId,
      actorClientId: null,
      actorSource: "direct",
      createdAt: now,
      updatedAt: now,
    });
    aliases.push("Countess");
    expect(person.aliases).toEqual(["Ada"]);

    expect(() =>
      decodePersonRow({
        id: randomUUID(),
        name: "Grace Hopper",
        aliases: [],
        notes: null,
        summary: null,
        tags: [],
        version: 1,
        actorKind: "oauth_client",
        actorAccountId: null,
        actorClientId: "client-without-account",
        actorSource: "mcp_http",
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow(PersonStoreContractError);
  });

  it("does not open a transaction when creation is already aborted", async () => {
    let transactions = 0;
    const database = {
      transaction() {
        transactions += 1;
        throw new Error("Transaction must not be opened.");
      },
    } as unknown as SecondBrainDatabase;
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(
      new DrizzleProjectStore(database).createProject(
        access(),
        { name: "Launch", description: null, idempotencyKey: "project-1" },
        controller.signal,
      ),
    ).rejects.toThrow("stop");
    await expect(
      new DrizzlePersonStore(database).createPerson(
        access(),
        { name: "Ada", aliases: [], notes: null, summary: null, tags: [], projectIds: [], knowledgeBaseIds: [], idempotencyKey: "person-1" },
        controller.signal,
      ),
    ).rejects.toThrow("stop");
    expect(transactions).toBe(0);
  });
});
