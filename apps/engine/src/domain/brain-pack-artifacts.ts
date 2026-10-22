import type { BrainPackArtifactKind } from "./brain-pack.js";

/** An uploaded or exported archive at rest. Access checks belong to the caller, not the store. */
export interface BrainPackArtifactRecord {
  readonly id: string;
  readonly kind: BrainPackArtifactKind;
  readonly ownerAccountId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly contentType: "application/zip";
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BrainPackArtifactPutInput {
  readonly kind: BrainPackArtifactKind;
  readonly ownerAccountId: string;
  readonly bytes: Uint8Array;
  readonly expiresAt: string;
  /** The hash the uploader claims; a mismatch is an integrity failure, never a silent overwrite. */
  readonly expectedSha256?: string;
}

/**
 * Where archives live between upload and validation, and between export and
 * download. The store hashes what it receives itself; callers decide who may
 * read a record.
 */
export interface BrainPackArtifactStore {
  put(input: BrainPackArtifactPutInput, signal?: AbortSignal): Promise<BrainPackArtifactRecord>;
  head(id: string, signal?: AbortSignal): Promise<BrainPackArtifactRecord | null>;
  read(id: string, signal?: AbortSignal): Promise<{ record: BrainPackArtifactRecord; bytes: Uint8Array } | null>;
  remove(id: string, signal?: AbortSignal): Promise<boolean>;
  /** Deletes every artifact whose `expiresAt` is at or before `now`; returns how many went. */
  expire(now: string, signal?: AbortSignal): Promise<number>;
}
