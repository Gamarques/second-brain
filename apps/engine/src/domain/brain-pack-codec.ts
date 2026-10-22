import { createHash } from "node:crypto";

import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { ZodError } from "zod";

import {
  BRAIN_PACK_FORMAT_VERSION,
  BrainPackError,
  brainPackCollectionsEntryPath,
  brainPackCollectionsFileSchema,
  brainPackDocumentContentPath,
  brainPackDocumentsEntryPath,
  brainPackDocumentsFileSchema,
  brainPackItemKeyFromContentPath,
  brainPackLimits,
  brainPackManifestEntryPath,
  brainPackManifestSchema,
  brainPackSourceSchema,
  validateBrainPackStructure,
  type BrainPack,
  type BrainPackCollection,
  type BrainPackDocument,
  type BrainPackDocumentEntry,
  type BrainPackInventoryEntry,
  type BrainPackManifest,
  type BrainPackSource,
} from "./brain-pack.js";

export interface EncodedBrainPack {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteSize: number;
  readonly manifest: BrainPackManifest;
}

/** Encodes validated content into an archive and decodes an archive into validated content. */
export interface BrainPackCodec {
  encode(source: BrainPackSource): EncodedBrainPack;
  decode(bytes: Uint8Array): BrainPack;
}

const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const HOST_UNIX = 3;
const UNIX_MODE_MASK = 0xf000;
const UNIX_DIRECTORY = 0x4000;
const UNIX_SYMLINK = 0xa000;
const MSDOS_DIRECTORY = 0x10;
const ZIP64_MARKER_32 = 0xffff_ffff;
const ZIP64_MARKER_16 = 0xffff;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_RECORD_SIZE = 22;
const MAXIMUM_COMMENT_SIZE = 0xffff;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function issueDetails(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`);
}

function decodeUtf8(path: string, bytes: Uint8Array): string {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "An entry is not UTF-8 text.", [`${path}: not valid UTF-8`]);
  }
  if (text.includes("\0")) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "An entry contains binary data.", [`${path}: contains a NUL byte`]);
  }
  return text;
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "An entry is not valid JSON.", [`${path}: not valid JSON`]);
  }
}

interface CentralDirectoryEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly host: number;
}

function integrity(message: string, details: readonly string[] = []): never {
  throw new BrainPackError("PACK_INTEGRITY_FAILED", message, details);
}

/**
 * Reads the central directory without inflating anything, so counts, sizes,
 * methods and entry kinds are checked before a byte is decompressed.
 */
function readCentralDirectory(bytes: Uint8Array): CentralDirectoryEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - END_RECORD_SIZE - MAXIMUM_COMMENT_SIZE);
  let endRecord = -1;
  for (let offset = bytes.byteLength - END_RECORD_SIZE; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) integrity("The archive has no end-of-central-directory record.");
  const diskEntries = view.getUint16(endRecord + 8, true);
  const totalEntries = view.getUint16(endRecord + 10, true);
  const directorySize = view.getUint32(endRecord + 12, true);
  const directoryOffset = view.getUint32(endRecord + 16, true);
  if (totalEntries === ZIP64_MARKER_16 || directorySize === ZIP64_MARKER_32 || directoryOffset === ZIP64_MARKER_32) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "ZIP64 archives are larger than a Brain Pack may be.");
  }
  if (diskEntries !== totalEntries || directoryOffset + directorySize > endRecord) {
    integrity("The archive's central directory is inconsistent.");
  }
  if (totalEntries > brainPackLimits.entries) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The archive has too many entries.", [
      `entries: ${totalEntries} > ${brainPackLimits.entries}`,
    ]);
  }

  const entries: CentralDirectoryEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endRecord || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) {
      integrity("The archive's central directory is truncated.");
    }
    const host = view.getUint8(offset + 5);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nameStart = offset + 46;
    if (nameStart + nameLength + extraLength + commentLength > endRecord) {
      integrity("The archive's central directory is truncated.");
    }
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      integrity("An entry name is not UTF-8.");
    }
    if ((flags & FLAG_UTF8) === 0 && nameBytes.some((byte) => byte > 0x7f)) {
      integrity("An entry name uses a legacy encoding.", [name]);
    }
    if (compressedSize === ZIP64_MARKER_32 || uncompressedSize === ZIP64_MARKER_32) {
      throw new BrainPackError("PACK_LIMIT_EXCEEDED", "ZIP64 entries are larger than a Brain Pack may be.", [name]);
    }
    entries.push({ name, method, flags, compressedSize, uncompressedSize, externalAttributes, host });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function isAllowedPath(name: string): boolean {
  if (name === brainPackManifestEntryPath || name === brainPackCollectionsEntryPath || name === brainPackDocumentsEntryPath) {
    return true;
  }
  return brainPackItemKeyFromContentPath(name) !== null;
}

function isRegularFile(entry: CentralDirectoryEntry): boolean {
  if (entry.name.endsWith("/")) return false;
  if ((entry.externalAttributes & MSDOS_DIRECTORY) !== 0) return false;
  if (entry.host === HOST_UNIX) {
    const mode = (entry.externalAttributes >>> 16) & UNIX_MODE_MASK;
    if (mode === UNIX_DIRECTORY || mode === UNIX_SYMLINK) return false;
  }
  return true;
}

function checkEntries(entries: readonly CentralDirectoryEntry[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  let expanded = 0;
  for (const entry of entries) {
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) integrity("The archive contains an encrypted entry.", [entry.name]);
    if (entry.method !== ZIP_STORED && entry.method !== ZIP_DEFLATED) {
      integrity("The archive uses an unsupported compression method.", [entry.name]);
    }
    if (!isRegularFile(entry)) {
      problems.push(`${entry.name}: directories and links are not allowed`);
    } else if (!isAllowedPath(entry.name)) {
      problems.push(`${entry.name}: not a Brain Pack entry`);
    }
    if (seen.has(entry.name)) problems.push(`${entry.name}: duplicate entry`);
    seen.add(entry.name);
    expanded += entry.uncompressedSize;
  }
  if (problems.length > 0) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "The archive contains entries a Brain Pack cannot have.", problems);
  }
  if (expanded > brainPackLimits.expandedBytes) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The archive expands beyond the limit.", [
      `expanded bytes: ${expanded} > ${brainPackLimits.expandedBytes}`,
    ]);
  }
  if (!seen.has(brainPackManifestEntryPath)) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "The archive has no manifest.json.");
  }
}

function inflate(bytes: Uint8Array, entries: readonly CentralDirectoryEntry[]): Map<string, Uint8Array> {
  const expected = new Map(entries.map((entry) => [entry.name, entry.uncompressedSize]));
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, { filter: (file) => expected.has(file.name) });
  } catch (error) {
    integrity("The archive could not be decompressed.", [error instanceof Error ? error.message : String(error)]);
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, size] of expected) {
    const content = unzipped[name];
    if (content === undefined) integrity("An entry could not be decompressed.", [name]);
    if (content.byteLength !== size) integrity("An entry's declared size does not match its data.", [name]);
    files.set(name, content);
  }
  return files;
}

function readManifest(files: Map<string, Uint8Array>): BrainPackManifest {
  const raw = parseJson(brainPackManifestEntryPath, decodeUtf8(brainPackManifestEntryPath, files.get(brainPackManifestEntryPath)!));
  const declaredVersion =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { formatVersion?: unknown }).formatVersion : undefined;
  if (typeof declaredVersion === "number" && declaredVersion !== BRAIN_PACK_FORMAT_VERSION) {
    throw new BrainPackError("PACK_FORMAT_UNSUPPORTED", `Brain Pack format version ${declaredVersion} is not supported; this build reads version ${BRAIN_PACK_FORMAT_VERSION}.`, [
      `formatVersion: ${declaredVersion}`,
    ]);
  }
  const parsed = brainPackManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "manifest.json is invalid.", issueDetails(parsed.error));
  }
  return parsed.data;
}

function checkInventory(manifest: BrainPackManifest, files: Map<string, Uint8Array>): void {
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const entry of manifest.inventory) {
    if (entry.path === brainPackManifestEntryPath) problems.push("inventory: the manifest must not list itself");
    if (declared.has(entry.path)) problems.push(`inventory: ${entry.path} is listed twice`);
    declared.add(entry.path);
    if (!files.has(entry.path)) problems.push(`inventory: ${entry.path} is declared but missing`);
  }
  for (const name of files.keys()) {
    if (name !== brainPackManifestEntryPath && !declared.has(name)) problems.push(`inventory: ${name} is not declared`);
  }
  for (const required of [brainPackCollectionsEntryPath, brainPackDocumentsEntryPath]) {
    if (!files.has(required)) problems.push(`inventory: ${required} is missing`);
  }
  if (problems.length > 0) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "The manifest inventory does not match the archive.", problems);
  }

  const mismatches: string[] = [];
  for (const entry of manifest.inventory) {
    const content = files.get(entry.path)!;
    if (content.byteLength !== entry.byteSize) mismatches.push(`${entry.path}: size ${content.byteLength} != declared ${entry.byteSize}`);
    else if (sha256Hex(content) !== entry.sha256) mismatches.push(`${entry.path}: SHA-256 does not match the manifest`);
  }
  if (mismatches.length > 0) {
    throw new BrainPackError("PACK_INTEGRITY_FAILED", "Entry hashes or sizes do not match the manifest.", mismatches);
  }
}

function readCollections(files: Map<string, Uint8Array>): BrainPackCollection[] {
  const raw = parseJson(brainPackCollectionsEntryPath, decodeUtf8(brainPackCollectionsEntryPath, files.get(brainPackCollectionsEntryPath)!));
  const parsed = brainPackCollectionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "collections.json is invalid.", issueDetails(parsed.error));
  }
  return parsed.data.collections;
}

function readDocumentEntries(files: Map<string, Uint8Array>): BrainPackDocumentEntry[] {
  const raw = parseJson(brainPackDocumentsEntryPath, decodeUtf8(brainPackDocumentsEntryPath, files.get(brainPackDocumentsEntryPath)!));
  const parsed = brainPackDocumentsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "documents.json is invalid.", issueDetails(parsed.error));
  }
  return parsed.data.documents;
}

function attachContent(entries: readonly BrainPackDocumentEntry[], files: Map<string, Uint8Array>): BrainPackDocument[] {
  const problems: string[] = [];
  const contentPaths = new Set([...files.keys()].filter((name) => brainPackItemKeyFromContentPath(name) !== null));
  const documents: BrainPackDocument[] = [];
  for (const entry of entries) {
    const expectedPath = brainPackDocumentContentPath(entry.key);
    if (entry.contentPath !== expectedPath) {
      problems.push(`documents.${entry.key}.contentPath: expected ${expectedPath}`);
      continue;
    }
    const bytes = files.get(expectedPath);
    if (bytes === undefined) {
      problems.push(`${expectedPath}: missing for documents.${entry.key}`);
      continue;
    }
    contentPaths.delete(expectedPath);
    const { contentPath: _contentPath, ...rest } = entry;
    documents.push({ ...rest, content: decodeUtf8(expectedPath, bytes) });
  }
  for (const orphan of contentPaths) problems.push(`${orphan}: no document entry names this file`);
  if (problems.length > 0) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "documents.json and the document files do not agree.", problems);
  }
  return documents;
}

/** Validates an archive completely and returns its content; throws `BrainPackError` otherwise. */
export function decodeBrainPack(bytes: Uint8Array): BrainPack {
  if (bytes.byteLength === 0) integrity("The archive is empty.");
  if (bytes.byteLength > brainPackLimits.compressedBytes) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The archive is larger than a Brain Pack may be.", [
      `compressed bytes: ${bytes.byteLength} > ${brainPackLimits.compressedBytes}`,
    ]);
  }
  const entries = readCentralDirectory(bytes);
  checkEntries(entries);
  const files = inflate(bytes, entries);
  const manifest = readManifest(files);
  checkInventory(manifest, files);
  const collections = readCollections(files);
  const documents = attachContent(readDocumentEntries(files), files);
  validateBrainPackStructure({ collections, documents: documents.map((document) => ({ ...document, contentPath: brainPackDocumentContentPath(document.key) })) });
  return { manifest, collections, documents };
}

function orderedCollection(collection: BrainPackCollection): BrainPackCollection {
  return {
    key: collection.key,
    name: collection.name,
    description: collection.description,
    documentKeys: [...collection.documentKeys],
  };
}

function orderedDocumentEntry(document: BrainPackDocument): BrainPackDocumentEntry {
  return {
    key: document.key,
    collectionKey: document.collectionKey,
    title: document.title,
    tags: [...document.tags],
    sourceUri: document.sourceUri,
    attribution: {
      authors: document.attribution.authors.map((author) => ({ name: author.name, uri: author.uri })),
      origin: document.attribution.origin
        ? {
            publisherNamespace: document.attribution.origin.publisherNamespace,
            packId: document.attribution.origin.packId,
            itemKey: document.attribution.origin.itemKey,
            packRevision: document.attribution.origin.packRevision,
          }
        : null,
      sourceRevision: document.attribution.sourceRevision
        ? { number: document.attribution.sourceRevision.number, contentSha256: document.attribution.sourceRevision.contentSha256 }
        : null,
    },
    references: document.references.map((reference) => ({ targetKey: reference.targetKey, kind: reference.kind })),
    representation: document.representation,
    contentPath: brainPackDocumentContentPath(document.key),
  };
}

/**
 * Encodes validated content into a deterministic archive: fixed key order in
 * the JSON entries, entries sorted by path, one modification time taken from
 * the manifest, and an inventory that hashes the exact bytes written.
 */
export function encodeBrainPack(source: BrainPackSource): EncodedBrainPack {
  const parsed = brainPackSourceSchema.safeParse(source);
  if (!parsed.success) {
    throw new BrainPackError("PACK_MANIFEST_INVALID", "The pack source is invalid.", issueDetails(parsed.error));
  }
  const { manifest: header, collections, documents } = parsed.data;
  validateBrainPackStructure({ collections, documents });

  const entries = new Map<string, Uint8Array>();
  entries.set(
    brainPackCollectionsEntryPath,
    strToU8(`${JSON.stringify({ collections: collections.map(orderedCollection) }, null, 2)}\n`),
  );
  entries.set(
    brainPackDocumentsEntryPath,
    strToU8(`${JSON.stringify({ documents: documents.map(orderedDocumentEntry) }, null, 2)}\n`),
  );
  for (const document of documents) {
    entries.set(brainPackDocumentContentPath(document.key), strToU8(document.content));
  }
  const paths = [...entries.keys()].sort();
  const inventory: BrainPackInventoryEntry[] = paths.map((path) => {
    const bytes = entries.get(path)!;
    return { path, byteSize: bytes.byteLength, sha256: sha256Hex(bytes) };
  });
  const expanded = inventory.reduce((sum, entry) => sum + entry.byteSize, 0);
  if (expanded > brainPackLimits.expandedBytes) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The pack expands beyond the limit.", [
      `expanded bytes: ${expanded} > ${brainPackLimits.expandedBytes}`,
    ]);
  }
  const manifest: BrainPackManifest = {
    formatVersion: BRAIN_PACK_FORMAT_VERSION,
    packId: header.packId,
    packRevision: header.packRevision,
    publisher: { namespace: header.publisher.namespace, displayName: header.publisher.displayName },
    title: header.title,
    description: header.description,
    createdAt: header.createdAt,
    language: header.language,
    inventory,
  };

  const zippable: Zippable = {};
  zippable[brainPackManifestEntryPath] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  for (const path of paths) zippable[path] = entries.get(path)!;
  const bytes = zipSync(zippable, { level: 6, mtime: new Date(manifest.createdAt) });
  if (bytes.byteLength > brainPackLimits.compressedBytes) {
    throw new BrainPackError("PACK_LIMIT_EXCEEDED", "The archive is larger than a Brain Pack may be.", [
      `compressed bytes: ${bytes.byteLength} > ${brainPackLimits.compressedBytes}`,
    ]);
  }
  return { bytes, sha256: sha256Hex(bytes), byteSize: bytes.byteLength, manifest };
}

export const brainPackCodec: BrainPackCodec = {
  encode: encodeBrainPack,
  decode: decodeBrainPack,
};
