import { describe, expect, it } from "vitest";

import type { ConfigEntries, Overview } from "./api-types";
import { translate } from "./i18n/catalog";
import {
  buildConnectStep,
  buildOptionalSteps,
  buildRequiredSteps,
  buildWarningSteps,
  firstIncompleteStep,
  nextFounderAction,
} from "./onboarding";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    settings: {
      timeZone: "UTC",
      reminderDeliveryEnabled: false, dreamingEnabled: false,
      dreamLocalTime: "03:00",
      nextDreamAt: null,
      dreamingMode: "preview",
      dailyInputTokenLimit: 1,
      dailyOutputTokenLimit: 1,
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    workerSummary: { healthy: 0, stale: 0, offline: 0 },
    jobSummary: { pending: 0, running: 0, failed: 0 },
    counts: { memories: 0, knowledgeBases: 0, knowledgeDocuments: 0 },
    latestReport: null,
    configuration: { pendingChanges: 0, restartRequired: false },
    ...overrides,
  };
}

function config(overrides: Partial<ConfigEntries> = {}): ConfigEntries {
  return { revision: 1, restartRequired: false, entries: [], ...overrides };
}

function configWithApiKey(isSet: boolean): ConfigEntries {
  return config({
    entries: [
      {
        name: "OPENROUTER_API_KEY",
        category: "models",
        description: "",
        isSet,
        isSecret: true,
        editable: true,
        source: "database",
        restartTargets: [],
        maskedValue: isSet ? "••••" : null,
        stagedValue: null,
        validationError: null,
      },
    ],
  });
}

describe("founder onboarding path", () => {
  it("requires only the AI key before connecting an app", () => {
    const required = buildRequiredSteps(config(), t);
    expect(required.map((step) => step.id)).toEqual(["apiKey"]);
    expect(required[0]?.complete).toBe(false);
    expect(buildRequiredSteps(configWithApiKey(true), t)[0]?.complete).toBe(true);
  });

  it("reads the API key step from OPENROUTER_API_KEY, not any other entry", () => {
    const withOtherEntrySet = buildRequiredSteps(
      config({
        entries: [
          {
            name: "OPENROUTER_ANSWER_MODEL",
            category: "models",
            description: "",
            isSet: true,
            isSecret: false,
            editable: true,
            source: "database",
            restartTargets: [],
            maskedValue: null,
            stagedValue: null,
            validationError: null,
          },
        ],
      }),
      t,
    );
    expect(withOtherEntrySet[0]?.complete).toBe(false);
  });

  it("keeps memories, documents, and nightly review optional so they never block connecting", () => {
    const optional = buildOptionalSteps(overview(), t);
    expect(optional.map((step) => step.id)).toEqual(["memory", "knowledgeBase", "dreaming"]);
    expect(optional.every((step) => !step.complete)).toBe(true);
  });

  it("warns about the overnight helper only when nightly review is enabled and none is running", () => {
    expect(buildWarningSteps(overview(), t)).toEqual([]);
    expect(buildWarningSteps(overview({ settings: { ...overview().settings, reminderDeliveryEnabled: false, dreamingEnabled: true } }), t).map((step) => step.id)).toEqual(["worker"]);
    expect(buildWarningSteps(overview({ workerSummary: { healthy: 1, stale: 0, offline: 0 } }), t)).toEqual([]);
  });

  it("sends a new founder to the AI key, then to Connect your AI", () => {
    const required = buildRequiredSteps(config(), t);
    const connect = buildConnectStep(t, 0);
    expect(nextFounderAction(required, connect)?.id).toBe("apiKey");
    expect(nextFounderAction(buildRequiredSteps(configWithApiKey(true), t), connect)?.id).toBe("connect");
    expect(nextFounderAction(buildRequiredSteps(configWithApiKey(true), t), buildConnectStep(t, 1))).toBeNull();
  });

  it("does not treat optional or warning steps as the next action", () => {
    const required = buildRequiredSteps(configWithApiKey(true), t);
    const connect = buildConnectStep(t, 0);
    expect(firstIncompleteStep([...required, ...buildOptionalSteps(overview(), t), ...buildWarningSteps(overview(), t)])?.id).toBe("memory");
    expect(nextFounderAction(required, connect)?.id).toBe("connect");
  });
});

describe("connected app milestone", () => {
  it("is complete only after the server reports an authorized external client", () => {
    expect(buildConnectStep(t, 0).complete).toBe(false);
    expect(buildConnectStep(t, 1).complete).toBe(true);
    expect(buildConnectStep(t, 3).complete).toBe(true);
  });
});
