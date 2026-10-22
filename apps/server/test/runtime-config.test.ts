import { describe, expect, it } from "vitest";

import { localPrincipal } from "@second-brain/engine/local-principal";
import { createSecondBrainAutomationRuntime } from "../src/runtime.js";
import { createConfiguredModelProvider } from "@second-brain/engine/runtime-config";

describe("runtime configuration", () => {
  it("builds one explicit provider identity for bootstrap and serving", () => {
    const configured = createConfiguredModelProvider({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_EMBEDDING_MODEL: "provider/embedding-model",
      OPENROUTER_EMBEDDING_MODEL_REVISION: "2026-08-16",
      OPENROUTER_DREAMING_MODEL: "provider/dreaming-model",
    });

    expect(configured.embeddingIdentity).toEqual({
      provider: "openrouter",
      model: "provider/embedding-model",
      modelRevision: "2026-08-16",
      dimensions: 1_536,
    });
    expect(configured.dreamingModel).toBe("provider/dreaming-model");
  });

  it("rejects missing secrets and malformed optional configuration", () => {
    expect(() => createConfiguredModelProvider({})).toThrow(
      /required environment variable/i,
    );
    expect(() =>
      createConfiguredModelProvider({
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_REQUEST_TIMEOUT_MS: "0",
      }),
    ).toThrow(/positive integer/);
  });

  it("requires an explicit account UUID for trusted local adapters", () => {
    expect(() => localPrincipal({})).toThrow(/SECOND_BRAIN_ACCOUNT_ID/);
    expect(() =>
      localPrincipal({ SECOND_BRAIN_ACCOUNT_ID: "local:user" }),
    ).toThrow(/SECOND_BRAIN_ACCOUNT_ID/);
    expect(
      localPrincipal({
        SECOND_BRAIN_ACCOUNT_ID: "10000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ id: "10000000-0000-4000-8000-000000000001" });
  });

  it("does not require local USD pricing while validating worker configuration", async () => {
    await expect(
      createSecondBrainAutomationRuntime({
        DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/second_brain",
        OPENROUTER_API_KEY: "test-key",
        SECOND_BRAIN_WORKER_ID: "invalid worker id",
      }),
    ).rejects.toThrow(/SECOND_BRAIN_WORKER_ID is invalid/);
  });
});
