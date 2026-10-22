# Brain Pack format, version 1

A Brain Pack is a `.brainpack` file: a constrained ZIP archive that carries
selected knowledge bases and their current document text from one Second
Brain to another. It is the unit of import and export for the knowledge
capabilities and the only archive shape the importer accepts.

This document is the reference for the archive, the rules the codec enforces,
the identity model importers use, the limits, and the run and error contracts
around it. The implementation lives in `apps/engine/src/domain/brain-pack.ts`
(contract), `apps/engine/src/domain/brain-pack-codec.ts` (encode and decode)
and `apps/engine/src/capabilities/brain-pack-schemas.ts` (capability input and
output schemas).

## Archive layout

```
manifest.json           header and inventory of every other entry
collections.json        knowledge bases in the pack
documents.json          document metadata and content paths
documents/<key>.md      one UTF-8 text file per document
```

Every entry is a regular file. Directories, symbolic links, nested archives,
encrypted entries, ZIP64 records and any path outside the four shapes above
make the archive invalid. Entry names are ASCII; document files are named by
the document key, so `documents/<key>.md` is the only file a document may own.

The exporter writes the archive deterministically: the JSON entries use a
fixed key order and two-space indentation, entries are sorted by path, every
entry carries the manifest's `createdAt` as its modification time, and the
inventory hashes the exact bytes written. The same content produces the same
bytes and the same SHA-256.

## `manifest.json`

```json
{
  "formatVersion": 1,
  "packId": "0f5b3b1c-6a3f-4c9a-9a1e-8a2c3d4e5f60",
  "packRevision": 3,
  "publisher": { "namespace": "acme.engineering", "displayName": "Acme Engineering" },
  "title": "Acme engineering handbook",
  "description": "Architecture notes and onboarding guides.",
  "createdAt": "2026-09-07T12:00:00.000Z",
  "language": "en",
  "inventory": [
    { "path": "collections.json", "byteSize": 412, "sha256": "…" },
    { "path": "documents.json", "byteSize": 1874, "sha256": "…" },
    { "path": "documents/architecture-notes.md", "byteSize": 2048, "sha256": "…" }
  ]
}
```

- `formatVersion` is the integer `1`. A different number fails with
  `PACK_FORMAT_UNSUPPORTED` before anything else is read.
- `packId` is a UUID the publisher chose; `packRevision` is a positive integer
  the publisher increments on every re-export of the same pack.
- `publisher.namespace` is a self-declared, reverse-DNS style label such as
  `acme.engineering`. It carries no proof of who published the pack.
- `description` and `language` may be `null`. `language` is a BCP 47 tag.
- `inventory` lists every entry except the manifest itself, exactly once, with
  its byte size and lowercase hexadecimal SHA-256. An entry that is in the
  archive but not in the inventory, or in the inventory but not in the archive,
  is a manifest error. A size or hash that disagrees with the bytes is an
  integrity error.

## `collections.json`

```json
{
  "collections": [
    {
      "key": "architecture",
      "name": "Architecture",
      "description": null,
      "documentKeys": ["architecture-notes", "notas-de-arquitetura"]
    }
  ]
}
```

A collection becomes a knowledge base on import. Every key in `documentKeys`
must name a document in `documents.json`, and every document must appear in
exactly one collection, the one its `collectionKey` names.

## `documents.json`

```json
{
  "documents": [
    {
      "key": "architecture-notes",
      "collectionKey": "architecture",
      "title": "Architecture notes",
      "tags": ["architecture"],
      "sourceUri": "https://acme.example/wiki/architecture",
      "attribution": {
        "authors": [{ "name": "Dana Ruiz", "uri": null }],
        "origin": null,
        "sourceRevision": { "number": 7, "contentSha256": "…" }
      },
      "references": [{ "targetKey": "notas-de-arquitetura", "kind": "related" }],
      "representation": "canonical",
      "contentPath": "documents/architecture-notes.md"
    }
  ]
}
```

- `contentPath` must equal `documents/<key>.md`.
- `attribution.origin`, when present, names the pack the document came from
  before this one: publisher namespace, pack ID, item key and pack revision.
  Re-exporting an imported document preserves it. It is history, not access.
- `attribution.sourceRevision` records the exporting brain's revision number
  and content hash as historical metadata. It does not certify the exported
  bytes; the inventory does.
- `references` point at documents inside the same pack. A reference to a key
  that is not in the pack, or to the document itself, fails with
  `PACK_REFERENCE_INVALID`.
- `representation` is `canonical` when the exporter had the text exactly as it
  was written, and `reconstructed` when the text was rebuilt from overlapping
  chunks. Importers store the representation with the revision so a later
  export can say the same.

Document content is UTF-8 text without NUL bytes, non-empty, and at most
1,000,000 characters.

## Keys and identity

Item keys are lowercase letters, digits and hyphens, one to 120 characters,
starting and ending with a letter or digit. They are stable across revisions
of the same pack and unique within the pack.

An importer identifies an item by the triple publisher namespace, pack ID and
item key, never by a foreign UUID alone. The mapping from that identity to a
local document is explicit and persisted, so re-importing a later revision
updates the same local document instead of duplicating it. The same document
UUID from two different publishers never collides.

## Limits

| Limit | Value |
| --- | --- |
| Compressed archive | 64 MiB |
| Expanded content | 256 MiB |
| Entries | 2,000 |
| Collections | 200 |
| Characters per document | 1,000,000 |
| Chunks per revision | 1,000 |
| Documents for a synchronous export | 200 |
| Expanded bytes for a synchronous export | 16 MiB |
| Embedding batch | 64 chunks |
| Active import runs per account | 1 |
| Active import runs per deployment | 2 |

Every limit is checked before decompression where the central directory
allows it, and before any model call in every case. Breaching one fails with
`PACK_LIMIT_EXCEEDED`.

## Validation order

The decoder reads the archive in this order and stops at the first failing
stage:

1. Size bounds and a well-formed central directory.
2. Entry count, entry kinds, compression method, encryption, ZIP64, paths,
   duplicates and the expanded size, all from the central directory.
3. Decompression, with each entry's data length checked against its declared
   size.
4. The manifest: format version, then schema.
5. The inventory: exact match with the archive, then byte sizes and hashes.
6. `collections.json` and `documents.json` schemas.
7. Document files: UTF-8, no NUL bytes, one per document entry and no orphans.
8. Cross-entry rules: unique keys, collection membership, content paths,
   character limits and references.

## Errors

| Code | Meaning |
| --- | --- |
| `PACK_FORMAT_UNSUPPORTED` | The manifest declares a format version this build does not read. |
| `PACK_MANIFEST_INVALID` | An entry is missing, undeclared, malformed, not text, or the entries disagree with each other. |
| `PACK_INTEGRITY_FAILED` | The archive is damaged or a size or hash does not match the manifest. |
| `PACK_LIMIT_EXCEEDED` | A version 1 limit was breached. |
| `PACK_REFERENCE_INVALID` | A reference names a document that is not in the pack. |
| `PACK_REVIEW_STALE` | A publication presented a review digest that no longer matches the run. |
| `PACK_REVISION_CONFLICT` | A local document changed after the review recorded its expected revision. |

Every error carries `details`, a list of the offending paths or fields.

## Runs

Import runs move through `uploaded → validating → awaiting_review → reviewed →
indexing → publishing → completed`, and may end in `failed` or `canceled`.
Export runs move through `queued → snapshotting → encoding → completed`, with
the same two terminal failures.

A review freezes the destination mapping for each collection, a decision per
item (`create`, `update`, `skip`, `separate_copy`, `keep_local`) and the local
revision each decision expects. The review digest binds the run, the manifest
hash, the mapping and the decisions; publication must present it, and a
publication with a digest that no longer matches fails with
`PACK_REVIEW_STALE`.

Publication indexes every accepted document locally, then writes everything in
one bounded transaction. The receipt lists the created and updated documents
with their revision IDs, plus the skipped and excluded items with a reason.

## Persistence

Archives are stored in PostgreSQL as `bytea` rows with their size, hash, owner
and expiry, so every service that can reach the database can reach the
archive and backups cover it. The pack, its revisions, its validated items,
the mapping from foreign items to local documents, the immutable origin of
every imported revision, the exact text of revisions where it is known, and
the runs with their per-item decisions and results each have their own table.
