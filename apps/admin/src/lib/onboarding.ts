import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "./api";
import type { ConfigEntries, Overview } from "./api-types";
import { useLocale, useTranslation, type Translator } from "./i18n";

export type OnboardingStepId = "apiKey" | "connect" | "dreaming" | "worker" | "memory" | "knowledgeBase";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  to: string;
  linkLabel: string;
  complete: boolean;
}

export interface OnboardingProgress {
  required: OnboardingStep[];
  connect: OnboardingStep;
  optional: OnboardingStep[];
  warnings: OnboardingStep[];
  next: OnboardingStep | null;
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

function apiKeyConfigured(config: ConfigEntries): boolean {
  return config.entries.find((entry) => entry.name === "OPENROUTER_API_KEY")?.isSet ?? false;
}

export function buildRequiredSteps(config: ConfigEntries, t: Translator): OnboardingStep[] {
  return [
    {
      id: "apiKey",
      title: t("onboarding.steps.apiKey.title"),
      description: t("onboarding.steps.apiKey.description"),
      to: "/configuration/environment",
      linkLabel: t("onboarding.steps.apiKey.linkLabel"),
      complete: apiKeyConfigured(config),
    },
  ];
}

export function buildConnectStep(t: Translator, connectedClientCount: number): OnboardingStep {
  return {
    id: "connect",
    title: t("onboarding.connect.title"),
    description: t("onboarding.connect.description"),
    to: "/connect",
    linkLabel: t("onboarding.connect.linkLabel"),
    complete: connectedClientCount > 0,
  };
}

export function buildOptionalSteps(overview: Overview, t: Translator): OnboardingStep[] {
  return [
    {
      id: "memory",
      title: t("onboarding.steps.memory.title"),
      description: t("onboarding.steps.memory.description"),
      to: "/memories",
      linkLabel: t("onboarding.steps.memory.linkLabel"),
      complete: overview.counts.memories > 0,
    },
    {
      id: "knowledgeBase",
      title: t("onboarding.steps.knowledgeBase.title"),
      description: t("onboarding.steps.knowledgeBase.description"),
      to: "/knowledge",
      linkLabel: t("onboarding.steps.knowledgeBase.linkLabel"),
      complete: overview.counts.knowledgeBases > 0,
    },
    {
      id: "dreaming",
      title: t("onboarding.steps.dreaming.title"),
      description: t("onboarding.steps.dreaming.description"),
      to: "/automation/dreaming",
      linkLabel: t("onboarding.steps.dreaming.linkLabel"),
      complete: overview.settings.dreamingEnabled,
    },
  ];
}

export function buildWarningSteps(overview: Overview, t: Translator): OnboardingStep[] {
  if (!overview.settings.dreamingEnabled || overview.workerSummary.healthy > 0) return [];
  return [
    {
      id: "worker",
      title: t("onboarding.steps.worker.title"),
      description: t("onboarding.steps.worker.description"),
      to: "/automation/jobs",
      linkLabel: t("onboarding.steps.worker.linkLabel"),
      complete: false,
    },
  ];
}

export function firstIncompleteStep(steps: OnboardingStep[]): OnboardingStep | null {
  return steps.find((step) => !step.complete) ?? null;
}

export function nextFounderAction(required: OnboardingStep[], connect: OnboardingStep): OnboardingStep | null {
  return firstIncompleteStep(required) ?? (connect.complete ? null : connect);
}

export function useOnboardingProgress(): OnboardingProgress {
  const t = useTranslation();
  const { locale } = useLocale();
  const identity = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal), staleTime: 30_000 });
  const overview = useQuery({ queryKey: ["overview"], queryFn: ({ signal }) => api.overview(signal), refetchInterval: 30_000 });
  const config = useQuery({ queryKey: ["configuration", locale], queryFn: ({ signal }) => api.config(signal, locale) });

  const isLoading = overview.isPending || config.isPending || identity.isPending;
  const isError = overview.isError || config.isError || identity.isError;
  const model = useMemo(() => {
    if (!overview.data || !config.data || !identity.data) {
      return { required: [], connect: buildConnectStep(t, identity.data?.connectedClientCount ?? 0), optional: [], warnings: [], next: null };
    }
    const required = buildRequiredSteps(config.data, t);
    const connect = buildConnectStep(t, identity.data.connectedClientCount);
    return {
      required,
      connect,
      optional: buildOptionalSteps(overview.data, t),
      warnings: buildWarningSteps(overview.data, t),
      next: nextFounderAction(required, connect),
    };
  }, [overview.data, config.data, identity.data, t]);

  return {
    ...model,
    completedCount: model.required.filter((step) => step.complete).length + (model.connect.complete ? 1 : 0),
    totalCount: model.required.length + 1,
    allComplete: model.required.length > 0 && model.next === null,
    isLoading,
    isError,
    error: overview.error ?? config.error ?? identity.error,
    refetch: () => {
      void overview.refetch();
      void config.refetch();
      void identity.refetch();
    },
  };
}
