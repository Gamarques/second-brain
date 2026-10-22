import type { BrainPackErrorCode, BrainPackItemClassification, BrainPackItemDecision, BrainPackRunStatus } from "./brain-pack-types";
import { brainPackErrorCodes } from "./brain-pack-types";
import type { CatalogKey } from "./i18n/catalog";
import type { Locale } from "./i18n/locale";

export type BrainPackTone = "success" | "danger" | "neutral" | "warning" | "info";

const terminalStatuses: ReadonlySet<BrainPackRunStatus> = new Set(["completed", "failed", "canceled"]);

export function isBrainPackRunActive(status: BrainPackRunStatus): boolean {
  return !terminalStatuses.has(status);
}

/** The tone a run's status word carries: green when done, red when failed, amber while it waits for a person. */
export function brainPackStatusTone(status: BrainPackRunStatus): BrainPackTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "canceled":
      return "neutral";
    case "awaiting_review":
      return "warning";
    default:
      return "info";
  }
}

/** Which of the six import steps a run has reached; failures stay on the check step so the retry sits where it belongs. */
export function brainPackImportStep(status: BrainPackRunStatus): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (status) {
    case "uploaded":
    case "validating":
    case "failed":
      return 2;
    case "awaiting_review":
      return 3;
    default:
      return 6;
  }
}

export const brainPackClassificationTone: Record<BrainPackItemClassification, BrainPackTone> = {
  new: "success",
  updated: "info",
  unchanged: "neutral",
  conflicting: "warning",
  invalid: "danger",
};

/** The decision a reviewer most likely wants for each classification; conflicts default to keeping the local text. */
export function defaultBrainPackDecision(classification: BrainPackItemClassification): BrainPackItemDecision {
  switch (classification) {
    case "new":
      return "create";
    case "updated":
      return "update";
    case "conflicting":
      return "keep_local";
    default:
      return "skip";
  }
}

/** The decisions that make sense for a classification, in the order they are offered. */
export function allowedBrainPackDecisions(classification: BrainPackItemClassification): BrainPackItemDecision[] {
  switch (classification) {
    case "new":
      return ["create", "skip"];
    case "updated":
      return ["update", "separate_copy", "skip"];
    case "unchanged":
      return ["skip", "separate_copy"];
    case "conflicting":
      return ["keep_local", "update", "separate_copy", "skip"];
    case "invalid":
      return ["skip"];
  }
}

export function brainPackDecisionNeedsRevision(decision: BrainPackItemDecision): boolean {
  return decision === "update" || decision === "keep_local" || decision === "separate_copy";
}

const errorCodePattern = /PACK_[A-Z_]+/u;

/** The catalog key that explains a sanitized error; anything not a known code gets the generic message. */
export function brainPackErrorKey(error: string | null | undefined): CatalogKey {
  const code = errorCodePattern.exec(error ?? "")?.[0];
  if (code !== undefined && (brainPackErrorCodes as readonly string[]).includes(code)) {
    return `packs.errors.${code as BrainPackErrorCode}`;
  }
  return "packs.errors.unknown";
}

/** Hands a downloaded archive to the browser as a file; a no-op where object URLs do not exist (tests). */
export function saveBlob(blob: Blob, fileName: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The file name the download route sets, so the receipt can show it before the download starts. */
export function brainPackFileName(packId: string, revision: number): string {
  return `${packId}-r${revision}.brainpack`;
}

/**
 * A first guess at who is publishing, from the account's domain: `jane@example.academy`
 * becomes the namespace `academy.example` and the name "Example". Edited once, it is remembered.
 */
export function suggestPublisher(email: string | null | undefined): { namespace: string; displayName: string } {
  const domain = email?.split("@")[1]?.trim().toLowerCase() ?? "";
  const labels = domain.split(".").filter((label) => /^[a-z0-9-]+$/u.test(label));
  if (labels.length < 2) return { namespace: "", displayName: "" };
  const brand = labels[labels.length - 2]!;
  return { namespace: [...labels].reverse().join("."), displayName: brand.charAt(0).toUpperCase() + brand.slice(1) };
}

export interface BrainPackPublisherPreference {
  namespace: string;
  displayName: string;
  language: string | null;
}

const publisherStorageKey = "second-brain-admin.brain-pack-publisher";

export function readPublisherPreference(): BrainPackPublisherPreference | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(publisherStorageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const { namespace, displayName, language } = parsed as Record<string, unknown>;
    if (typeof namespace !== "string" || typeof displayName !== "string") return null;
    return { namespace, displayName, language: typeof language === "string" ? language : null };
  } catch {
    return null;
  }
}

export function writePublisherPreference(preference: BrainPackPublisherPreference): void {
  try {
    window.localStorage.setItem(publisherStorageKey, JSON.stringify(preference));
  } catch {
    // A blocked storage partition must never break an export.
  }
}

const byteUnits = ["B", "KB", "MB", "GB"] as const;

/** Binary units, one decimal below ten so limits like 64 MB read as the round numbers they are. */
export function formatBytes(bytes: number, locale: Locale): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)} ${byteUnits[unit]}`;
}
