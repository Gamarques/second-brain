import { createHash } from "node:crypto";

import type {
  IngestProposal,
  IngestProposalPayload,
  IngestReviewItem,
} from "./ingestion.js";

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "$"));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function ingestionRequestDigest(input: {
  readonly schemaVersion: string;
  readonly excerpt: string;
  readonly capturedAt: string | null;
}): string {
  return canonicalDigest(input);
}

export function ingestionProposalPayloadDigest(payload: IngestProposalPayload): string {
  return canonicalDigest(payload);
}

export function ingestionProposalSetDigest(
  proposals: readonly Pick<
    IngestProposal,
    | "id"
    | "ordinal"
    | "payloadDigest"
    | "confidence"
    | "sourceStart"
    | "sourceEnd"
    | "sourceQuote"
  >[],
): string {
  return canonicalDigest(
    [...proposals]
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((proposal) => ({ ...proposal })),
  );
}

export function ingestionReviewDigest(input: {
  readonly runId: string;
  readonly proposalDigest: string;
  readonly items: readonly IngestReviewItem[];
}): string {
  return canonicalDigest({
    runId: input.runId,
    proposalDigest: input.proposalDigest,
    items: [...input.items]
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId))
      .map((item) => ({ ...item })),
  });
}

function normalizeJson(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain a finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }
    const source = value as Readonly<Record<string, unknown>>;
    const normalized: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(source).sort()) {
      normalized[key] = normalizeJson(source[key], `${path}.${key}`);
    }
    return normalized;
  }
  throw new TypeError(`${path} contains a value that JSON cannot represent.`);
}
