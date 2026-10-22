import { createHash } from "node:crypto";

import { eq, lte } from "drizzle-orm";

import {
  BrainPackError,
  brainPackArtifactKinds,
  brainPackLimits,
} from "../../domain/brain-pack.js";
import type {
  BrainPackArtifactPutInput,
  BrainPackArtifactRecord,
  BrainPackArtifactStore,
} from "../../domain/brain-pack-artifacts.js";
import { knowledgePackArtifacts } from "../schema/brain-pack.js";
import type { SecondBrainDatabase } from "./database.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

type ArtifactRow = typeof knowledgePackArtifacts.$inferSelect;

function toRecord(row: Omit<ArtifactRow, "bytes">): BrainPackArtifactRecord {
  return {
    id: row.id,
    kind: row.kind,
    ownerAccountId: row.ownerAccountId,
    sha256: row.sha256,
    byteSize: row.byteSize,
    contentType: "application/zip",
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a UUID.`);
}

function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be an ISO-8601 instant.`);
  return parsed;
}

const metadataColumns = {
  id: knowledgePackArtifacts.id,
  kind: knowledgePackArtifacts.kind,
  ownerAccountId: knowledgePackArtifacts.ownerAccountId,
  contentType: knowledgePackArtifacts.contentType,
  byteSize: knowledgePackArtifacts.byteSize,
  sha256: knowledgePackArtifacts.sha256,
  createdAt: knowledgePackArtifacts.createdAt,
  expiresAt: knowledgePackArtifacts.expiresAt,
} as const;

/**
 * Archives at rest in PostgreSQL. The store hashes the bytes it receives and
 * refuses a claimed hash that disagrees, so a corrupted upload never reaches
 * validation looking intact. Who may read a record is the caller's decision.
 */
export class DrizzleBrainPackArtifactStore implements BrainPackArtifactStore {
  readonly #database: SecondBrainDatabase;

  constructor(database: SecondBrainDatabase) {
    this.#database = database;
  }

  async put(input: BrainPackArtifactPutInput): Promise<BrainPackArtifactRecord> {
    if (!(brainPackArtifactKinds as readonly string[]).includes(input.kind)) {
      throw new TypeError("kind must be upload or export.");
    }
    requireUuid(input.ownerAccountId, "ownerAccountId");
    const expiresAt = parseInstant(input.expiresAt, "expiresAt");
    if (input.bytes.byteLength === 0) {
      throw new BrainPackError("PACK_INTEGRITY_FAILED", "The archive is empty.");
    }
    if (input.bytes.byteLength > brainPackLimits.compressedBytes) {
      throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The archive is larger than a Brain Pack may be.", [
        `compressed bytes: ${input.bytes.byteLength} > ${brainPackLimits.compressedBytes}`,
      ]);
    }
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    if (input.expectedSha256 !== undefined) {
      if (!SHA256.test(input.expectedSha256)) throw new TypeError("expectedSha256 must be lowercase hex SHA-256.");
      if (input.expectedSha256 !== sha256) {
        throw new BrainPackError("PACK_INTEGRITY_FAILED", "The uploaded bytes do not match the declared SHA-256.", [
          `declared ${input.expectedSha256}`,
          `received ${sha256}`,
        ]);
      }
    }
    const [row] = await this.#database
      .insert(knowledgePackArtifacts)
      .values({
        kind: input.kind,
        ownerAccountId: input.ownerAccountId,
        contentType: "application/zip",
        byteSize: input.bytes.byteLength,
        sha256,
        bytes: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
        expiresAt,
      })
      .returning(metadataColumns);
    if (!row) throw new Error("The artifact was not stored.");
    return toRecord(row);
  }

  async head(id: string): Promise<BrainPackArtifactRecord | null> {
    requireUuid(id, "id");
    const [row] = await this.#database
      .select(metadataColumns)
      .from(knowledgePackArtifacts)
      .where(eq(knowledgePackArtifacts.id, id))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async read(id: string): Promise<{ record: BrainPackArtifactRecord; bytes: Uint8Array } | null> {
    requireUuid(id, "id");
    const [row] = await this.#database
      .select()
      .from(knowledgePackArtifacts)
      .where(eq(knowledgePackArtifacts.id, id))
      .limit(1);
    if (!row) return null;
    const stored = row.bytes;
    return {
      record: toRecord(row),
      bytes: new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength),
    };
  }

  async remove(id: string): Promise<boolean> {
    requireUuid(id, "id");
    const removed = await this.#database
      .delete(knowledgePackArtifacts)
      .where(eq(knowledgePackArtifacts.id, id))
      .returning({ id: knowledgePackArtifacts.id });
    return removed.length > 0;
  }

  async expire(now: string): Promise<number> {
    const cutoff = parseInstant(now, "now");
    const removed = await this.#database
      .delete(knowledgePackArtifacts)
      .where(lte(knowledgePackArtifacts.expiresAt, cutoff))
      .returning({ id: knowledgePackArtifacts.id });
    return removed.length;
  }
}
