import type { SecondBrainEngineDependencies } from "../../src/engine.js";

/** Dependency graph that fails if an engine-boundary test reaches domain IO. */
export function boundaryDependencies(): SecondBrainEngineDependencies {
  const unavailable = new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("A dependency was unexpectedly called by an engine boundary test.");
        };
      },
    },
  );
  const dependency = <T>(): T => unavailable as T;

  return {
    access: dependency(),
    projects: dependency(),
    people: dependency(),
    tasks: dependency(),
    reminders: dependency(),
    memories: dependency(),
    decisions: dependency(),
    knowledge: dependency(),
    search: dependency(),
    evidence: dependency(),
    embeddingSpaces: dependency(),
    goals: dependency(),
    priorities: dependency(),
    activities: dependency(),
    ingestion: dependency(),
    ingestionCommitter: dependency(),
    dreaming: dependency(),
    contexts: dependency(),
    embeddings: dependency(),
    answers: dependency(),
    ingestionProvider: dependency(),
    brainPacks: dependency(),
    brainPackArtifacts: dependency(),
    brainPackCodec: dependency(),
    automation: dependency(),
  };
}
