/**
 * The artifact store contract the transfer routes code against. The engine
 * owns the canonical definition together with its PostgreSQL implementation
 * (`knowledge_pack_artifacts`); the transport only re-exports it. Bytes are
 * opaque here: validating the archive is a domain concern, not a transport one.
 */
import type { BrainPackArtifactRecord } from "@second-brain/engine/domain/brain-pack-artifacts";

export type {
  BrainPackArtifactPutInput,
  BrainPackArtifactRecord,
  BrainPackArtifactStore,
} from "@second-brain/engine/domain/brain-pack-artifacts";

export type BrainPackArtifactKind = BrainPackArtifactRecord["kind"];
