import { randomUUID } from "node:crypto";

import type { SecondBrainDatabase } from "@second-brain/engine/database/client";
import {
  BrainAccessDeniedError,
  DrizzleBrainAccessStore,
} from "@second-brain/engine/database/stores/access-store";
import { DrizzleBrainPackArtifactStore } from "@second-brain/engine/database/stores/brain-pack-artifact-store";
import { DrizzleBrainPackStore } from "@second-brain/engine/database/stores/brain-pack-store";
import type {
  BrainAccessContext,
  BrainAccessStore,
  BrainPackArtifactStore,
  BrainPackStore,
} from "@second-brain/engine/domain";

import type { BrainPackTransferDependencies } from "./transfer.js";

export interface ExportArtifactResolverDependencies {
  readonly access: Pick<BrainAccessStore, "resolveAccess">;
  readonly packs: Pick<BrainPackStore, "getRun">;
  readonly artifacts: Pick<BrainPackArtifactStore, "read">;
}

/**
 * Finds the archive an export run produced, as the engine would show it to
 * this principal: the run tables decide visibility, so the resolver asks the
 * access store for the same administrative role the pack capabilities need
 * and answers `null` for anything it may not show.
 */
export function createExportArtifactResolver(
  dependencies: ExportArtifactResolverDependencies,
): BrainPackTransferDependencies["resolveExportArtifact"] {
  return async (runId, principal, signal) => {
    let access: BrainAccessContext;
    try {
      access = await dependencies.access.resolveAccess(
        {
          principal: { id: principal.id },
          requiredRole: "admin",
          source: "direct",
          requestId: randomUUID(),
          correlationId: null,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof BrainAccessDeniedError) return null;
      throw error;
    }
    const run = await dependencies.packs.getRun(access, runId, signal);
    if (
      run === null ||
      run.kind !== "export" ||
      run.artifactId === null ||
      run.pack === null ||
      run.packRevision === null
    ) {
      return null;
    }
    const artifact = await dependencies.artifacts.read(run.artifactId, signal);
    if (artifact === null) return null;
    return {
      record: artifact.record,
      bytes: artifact.bytes,
      packId: run.pack.externalPackId,
      packRevision: run.packRevision.number,
    };
  };
}

/** The transfer routes over the application database. */
export function createBrainPackTransferDependencies(
  database: SecondBrainDatabase,
): BrainPackTransferDependencies {
  const artifacts = new DrizzleBrainPackArtifactStore(database);
  return {
    artifacts,
    resolveExportArtifact: createExportArtifactResolver({
      access: new DrizzleBrainAccessStore(database),
      packs: new DrizzleBrainPackStore(database),
      artifacts,
    }),
  };
}
