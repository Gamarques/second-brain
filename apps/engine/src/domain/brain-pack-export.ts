import type { BrainPackPublisher, BrainPackSource } from "./brain-pack.js";
import type { BrainPackExportSnapshot } from "./brain-pack-store.js";

/** Stable, path-safe keys derived from local identifiers so a re-export keeps every key. */
export function brainPackCollectionKeyFor(knowledgeBaseId: string): string {
  return `kb-${knowledgeBaseId.toLowerCase()}`;
}

export function brainPackDocumentKeyFor(documentId: string): string {
  return `doc-${documentId.toLowerCase()}`;
}

export interface BrainPackExportHeader {
  readonly packId: string;
  readonly packRevision: number;
  readonly publisher: BrainPackPublisher;
  readonly title: string;
  readonly description: string | null;
  readonly language: string | null;
}

/**
 * Turns a frozen snapshot into what the codec encodes. Upstream attribution
 * survives a re-export; the representation says whether the text is the
 * exact revision or a reconstruction from chunks.
 */
export function buildBrainPackExportSource(
  snapshot: BrainPackExportSnapshot,
  header: BrainPackExportHeader,
): BrainPackSource {
  return {
    manifest: {
      formatVersion: 1,
      packId: header.packId,
      packRevision: header.packRevision,
      publisher: { namespace: header.publisher.namespace, displayName: header.publisher.displayName },
      title: header.title,
      description: header.description,
      createdAt: snapshot.frozenAt,
      language: header.language,
    },
    collections: snapshot.knowledgeBases.map((base) => ({
      key: brainPackCollectionKeyFor(base.id),
      name: base.name,
      description: base.description,
      documentKeys: base.documents.map((document) => brainPackDocumentKeyFor(document.id)),
    })),
    documents: snapshot.knowledgeBases.flatMap((base) =>
      base.documents.map((document) => ({
        key: brainPackDocumentKeyFor(document.id),
        collectionKey: brainPackCollectionKeyFor(base.id),
        title: document.title,
        tags: [...document.tags],
        sourceUri: document.sourceUri,
        attribution: {
          authors: document.origin === null ? [] : document.origin.authors.map((author) => ({ ...author })),
          origin:
            document.origin === null
              ? null
              : {
                  publisherNamespace: document.origin.publisher.namespace,
                  packId: document.origin.packId,
                  itemKey: document.origin.itemKey,
                  packRevision: document.origin.packRevision,
                },
          sourceRevision: { number: document.revision.number, contentSha256: document.revision.contentHash },
        },
        references: [],
        representation: document.representation,
        content: document.content,
      })),
    ),
  };
}
