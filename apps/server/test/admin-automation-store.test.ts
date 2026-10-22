import { describe, expect, it, vi } from "vitest";

import {
  AdminAutomationStoreContractError,
  DrizzleAdminAutomationStore,
} from "../src/services/admin/persistence/automation-store.js";
import type { SecondBrainDatabase } from "@second-brain/engine/database/stores/database";
import type { BrainAccessContext } from "@second-brain/engine/domain";

const access: BrainAccessContext = {
  accountId: "00000000-0000-4000-8000-000000000001",
  role: "admin",
  actor: {
    kind: "account",
    accountId: "00000000-0000-4000-8000-000000000001",
    clientId: null,
    source: "direct",
    requestId: "admin-automation-store-test",
    correlationId: null,
    causationId: null,
    dreamingRunId: null,
  },
};

function subject() {
  const transaction = vi.fn(() => {
    throw new Error("Database access was not expected.");
  });
  const store = new DrizzleAdminAutomationStore({
    transaction,
  } as unknown as SecondBrainDatabase);
  return { store, transaction };
}

describe("admin automation store input boundary", () => {
  it("rejects an empty settings update before database access", async () => {
    const { store, transaction } = subject();

    await expect(
      store.updateSettings(
        access,
        { expectedRevision: 1, idempotencyKey: "empty-settings" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AdminAutomationStoreContractError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid token limits before database access", async () => {
    const { store, transaction } = subject();

    await expect(
      store.updateSettings(
        access,
        {
          expectedRevision: 1,
          idempotencyKey: "invalid-limit",
          dailyInputTokenLimit: 1_000_001,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("dailyInputTokenLimit must be an integer between 1 and 1000000");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an impossible local date before database access", async () => {
    const { store, transaction } = subject();

    await expect(
      store.enqueueDreamingRun(
        access,
        { localDate: "2026-02-31", idempotencyKey: "impossible-date" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("localDate must be a valid YYYY-MM-DD date");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects unbounded job pages before database access", async () => {
    const { store, transaction } = subject();

    await expect(
      store.listJobs(
        access,
        { kind: null, status: null, cursor: null, limit: 101 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("limit must be an integer between 1 and 100");
    expect(transaction).not.toHaveBeenCalled();
  });
});
