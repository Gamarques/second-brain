import type { CatalogKey } from "./i18n/catalog";

/**
 * Every piece of jargon the console explains inline via `<GlossaryTerm>`
 * and lists in the browsable glossary dialog. Add an id here, then add its
 * `glossary.<id>.term` and `glossary.<id>.definition` pair to every locale
 * catalog (`en.ts`, `pt-BR.ts`, `es.ts`) — the catalog completeness test
 * fails if a locale is missing either half of a pair.
 */
export const glossaryIds = [
  "dreaming",
  "run",
  "dreamingMode",
  "jobQueue",
  "lease",
  "canonicalKey",
  "retryWait",
  "workerHeartbeat",
  "memoryLineage",
  "superseded",
  "provenance",
  "effectiveAt",
  "contentHash",
  "revision",
  "chunk",
  "embedding",
  "stagedConfiguration",
  "restartTarget",
  "expectedRevision",
  "idempotencyKey",
  "auditOutcome",
  "pkce",
  "mcp",
  "mcpServer",
  "mcpClient",
  "brainPack",
  "publisher",
] as const;

export type GlossaryId = (typeof glossaryIds)[number];

export function glossaryTermKey(id: GlossaryId): CatalogKey {
  return `glossary.${id}.term` as CatalogKey;
}

export function glossaryDefinitionKey(id: GlossaryId): CatalogKey {
  return `glossary.${id}.definition` as CatalogKey;
}
