import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const FORBIDDEN_ARCHIVE_ROOT = "second-brain";
const BLOCK_SIZE = 512;
const MINIMUM_TAR_SIZE = 10_240;
const MAXIMUM_ARCHIVE_SIZE = 2_147_483_648;

interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

interface ArchiveSource {
  readonly archivePath: string;
  readonly content: Buffer;
  readonly mode: number;
}

export interface ArtifactEntry {
  readonly name: string;
  readonly byteSize: number;
  readonly mode: number;
}

export interface ArtifactBuildResult {
  readonly archive: Buffer;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface ArtifactValidationResult {
  readonly entries: readonly ArtifactEntry[];
  readonly sha256: string;
  readonly byteSize: number;
}

export interface BuildArtifactInput {
  readonly sourceRoot?: string;
  readonly revision?: string;
}

function runGit(root: string, arguments_: readonly string[]): Buffer {
  try {
    return execFileSync("git", ["-C", root, ...arguments_], {
      maxBuffer: MAXIMUM_ARCHIVE_SIZE,
    });
  } catch (error) {
    throw new Error(
      `Unable to read the Git source tree: git ${arguments_.join(" ")}`,
      { cause: error },
    );
  }
}

function validateRepositoryPath(value: string, label = "repository path"): void {
  if (
    value === "" ||
    value.length > 4_096 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}.`);
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component === "" || component === "." || component === "..",
    )
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}.`);
  }
}

function basename(value: string): string {
  const components = value.split("/");
  return components[components.length - 1] ?? value;
}

export function isExcludedArtifactPath(value: string): boolean {
  validateRepositoryPath(value);
  const components = value.split("/");
  const name = basename(value);
  const lowerName = name.toLowerCase();
  if (
    components.includes(".git") ||
    components.includes("node_modules") ||
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    components.slice(0, 2).join("/") === ".claude/worktrees" ||
    value === ".claude.json" ||
    (components[0] === ".claude" &&
      name === "settings.local.json") ||
    name === ".installer-state.json" ||
    name === ".invokta-state.json" ||
    name === "auth.json" ||
    name === "credentials.json" ||
    name === ".npmrc" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    /\.(?:pem|key|p12|pfx)$/iu.test(name) ||
    /^service-account.*\.json$/iu.test(lowerName)
  ) {
    return true;
  }
  return false;
}

function parseTreeEntries(output: Buffer): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) throw new Error("The Git tree output is not NUL terminated.");
    const separator = output.indexOf(9, start, "latin1");
    if (separator < 0 || separator > end) {
      throw new Error("The Git tree output is malformed.");
    }
    const metadata = output.subarray(start, separator).toString("ascii");
    const parts = metadata.split(" ");
    if (parts.length !== 3) {
      throw new Error("The Git tree entry metadata is malformed.");
    }
    const [mode, type, oid] = parts as [string, string, string];
    const entryPath = output.subarray(separator + 1, end).toString("utf8");
    validateRepositoryPath(entryPath);
    if (entries.has(entryPath)) {
      throw new Error(`Duplicate Git tree path: ${entryPath}.`);
    }
    entries.set(entryPath, { path: entryPath, mode, type, oid });
    start = end + 1;
  }
  return entries;
}

function resolveGitBlob(root: string, entry: GitTreeEntry): Buffer {
  return runGit(root, ["cat-file", "blob", entry.oid]);
}

function resolveSymlink(
  root: string,
  entry: GitTreeEntry,
  allEntries: ReadonlyMap<string, GitTreeEntry>,
): ArchiveSource | undefined {
  const seen = new Set<string>([entry.path]);
  let current = entry;
  let mode = current.mode;
  let content = resolveGitBlob(root, current);
  while (mode === "120000") {
    const target = content.toString("utf8");
    validateRepositoryPath(target, "symbolic link target");
    const parent = path.posix.dirname(current.path);
    const resolved = path.posix.normalize(path.posix.join(parent, target));
    validateRepositoryPath(resolved, "resolved symbolic link target");
    if (isExcludedArtifactPath(resolved)) return undefined;
    if (seen.has(resolved)) {
      throw new Error(`Circular symbolic link at ${entry.path}.`);
    }
    seen.add(resolved);
    const next = allEntries.get(resolved);
    if (next === undefined || next.type !== "blob") {
      throw new Error(`Symbolic link ${entry.path} has no tracked file target.`);
    }
    current = next;
    mode = current.mode;
    content = resolveGitBlob(root, current);
  }
  if (mode !== "100644" && mode !== "100755") {
    throw new Error(`Symbolic link ${entry.path} resolves to an unsafe entry.`);
  }
  return {
    archivePath: entry.path,
    content,
    mode: mode === "100755" ? 0o755 : 0o644,
  };
}

function selectSources(
  root: string,
  revision: string,
): readonly ArchiveSource[] {
  const treeOutput = runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    revision,
  ]);
  const entries = parseTreeEntries(treeOutput);
  const sources: ArchiveSource[] = [];
  for (const entry of entries.values()) {
    if (isExcludedArtifactPath(entry.path)) continue;
    if (entry.type !== "blob") {
      throw new Error(`The archive source ${entry.path} is not a file.`);
    }
    if (entry.mode === "100644" || entry.mode === "100755") {
      sources.push({
        archivePath: entry.path,
        content: resolveGitBlob(root, entry),
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    } else if (entry.mode === "120000") {
      const source = resolveSymlink(root, entry, entries);
      if (source !== undefined) sources.push(source);
    } else {
      throw new Error(
        `The archive source ${entry.path} has unsupported Git mode ${entry.mode}.`,
      );
    }
  }
  sources.sort((left, right) =>
    left.archivePath < right.archivePath
      ? -1
      : left.archivePath > right.archivePath
        ? 1
        : 0,
  );
  return sources;
}

function writeAscii(
  buffer: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  if (Buffer.byteLength(value, "ascii") > length) {
    throw new Error(`The tar field at offset ${offset} is too long.`);
  }
  buffer.write(value, offset, length, "ascii");
}

function writeOctal(
  buffer: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new Error(`The tar numeric field at offset ${offset} is too long.`);
  }
  writeAscii(buffer, `${digits.padStart(length - 1, "0")}\0`, offset, length);
}

function setTarName(header: Buffer, name: string): void {
  if (Buffer.byteLength(name, "utf8") <= 100) {
    writeAscii(header, name, 0, 100);
    return;
  }
  for (let index = 0; index < name.length; index += 1) {
    if (name[index] !== "/") continue;
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(suffix, "utf8") <= 100
    ) {
      writeAscii(header, suffix, 0, 100);
      writeAscii(header, prefix, 345, 155);
      return;
    }
  }
  throw new Error(`The tar path is too long: ${name}.`);
}

function tarHeader(source: ArchiveSource): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  setTarName(header, source.archivePath);
  writeOctal(header, source.mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, source.content.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.write("        ", 148, 8, "ascii");
  writeAscii(header, "0", 156, 1);
  writeAscii(header, "ustar\0", 257, 6);
  writeAscii(header, "00", 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeAscii(
    header,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    148,
    8,
  );
  return header;
}

function createTar(sources: readonly ArchiveSource[]): Buffer {
  const parts: Buffer[] = [];
  for (const source of sources) {
    parts.push(tarHeader(source), source.content);
    const padding = (BLOCK_SIZE - (source.content.length % BLOCK_SIZE)) %
      BLOCK_SIZE;
    parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  const tar = Buffer.concat(parts);
  if (tar.length < MINIMUM_TAR_SIZE) {
    return Buffer.concat([
      tar,
      Buffer.alloc(MINIMUM_TAR_SIZE - tar.length),
    ]);
  }
  return tar;
}

function parseTarSize(header: Buffer): number {
  return parseTarOctal(header.subarray(124, 136));
}

function parseTarOctal(value: Buffer): number {
  const raw = value.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(raw)) throw new Error("A tar entry has an invalid size.");
  return Number.parseInt(raw, 8);
}

function parseTarChecksum(header: Buffer): number {
  const stored = header.toString("ascii", 148, 156).replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(stored)) {
    throw new Error("A tar entry has an invalid checksum.");
  }
  const expected = Number.parseInt(stored, 8);
  const comparison = Buffer.from(header);
  comparison.write("        ", 148, 8, "ascii");
  let actual = 0;
  for (const byte of comparison) actual += byte;
  if (actual !== expected) throw new Error("A tar entry checksum mismatch.");
  return expected;
}

function parseTarPath(header: Buffer): string {
  const name = header.toString("utf8", 0, 100).replace(/\0.*$/u, "");
  const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/u, "");
  return prefix === "" ? name : `${prefix}/${name}`;
}

function validateArchivePath(value: string): void {
  validateRepositoryPath(value, "archive path");
  if (value.startsWith(`${FORBIDDEN_ARCHIVE_ROOT}/`)) {
    throw new Error(
      `Unexpected wrapped archive layout; entries must be repository-root relative.`,
    );
  }
  if (value.includes("\0")) {
    throw new Error("An archive path contains a NUL byte.");
  }
  if (isExcludedArtifactPath(value)) {
    throw new Error(`The archive contains an excluded path: ${value}.`);
  }
}

export function validateArtifact(archive: Buffer): ArtifactValidationResult {
  if (archive.length === 0 || archive.length > MAXIMUM_ARCHIVE_SIZE) {
    throw new Error("The archive size is outside the allowed range.");
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (error) {
    throw new Error("The artifact is not valid gzip data.", { cause: error });
  }
  if (tar.length < BLOCK_SIZE * 2) {
    throw new Error("The tar archive is truncated.");
  }

  const entries: ArtifactEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let sawEnd = false;
  while (offset + BLOCK_SIZE <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK_SIZE);
    if (block.every((byte) => byte === 0)) {
      sawEnd = true;
      offset += BLOCK_SIZE;
      break;
    }
    if (offset + BLOCK_SIZE > tar.length) {
      throw new Error("The tar archive has a truncated header.");
    }
    parseTarChecksum(block);
    const typeflag = block.toString("ascii", 156, 157);
    if (typeflag !== "0" && typeflag !== "\0") {
      throw new Error(
        "The archive contains a directory, link, or other non-regular entry.",
      );
    }
    const linkname = block.toString("utf8", 157, 257).replace(/\0.*$/u, "");
    if (linkname !== "") {
      throw new Error("The archive contains a hard link.");
    }
    const name = parseTarPath(block);
    validateArchivePath(name);
    if (seen.has(name)) {
      throw new Error(`Duplicate archive path: ${name}.`);
    }
    if (
      entries.length > 0 &&
      name <= entries[entries.length - 1]!.name
    ) {
      throw new Error("Archive entries are not sorted and unique.");
    }
    const byteSize = parseTarSize(block);
    const end = offset + BLOCK_SIZE + byteSize;
    if (end > tar.length) {
      throw new Error("The tar archive has truncated file data.");
    }
    if ((end % BLOCK_SIZE) !== 0 && end + 1 > tar.length) {
      throw new Error("The tar archive is missing entry padding.");
    }
    const mode = Number.parseInt(
      block.toString("ascii", 100, 108).replace(/\0.*$/u, "").trim(),
      8,
    );
    if (!Number.isInteger(mode) || (mode !== 0o644 && mode !== 0o755)) {
      throw new Error(`The archive entry ${name} has an unsafe mode.`);
    }
    const uid = parseTarOctal(block.subarray(108, 116));
    const gid = parseTarOctal(block.subarray(116, 124));
    const mtime = parseTarOctal(block.subarray(136, 148));
    if (uid !== 0 || gid !== 0 || mtime !== 0) {
      throw new Error(`The archive entry ${name} has non-deterministic metadata.`);
    }
    entries.push({ name, byteSize, mode });
    seen.add(name);
    offset += BLOCK_SIZE + byteSize;
    offset += (BLOCK_SIZE - (byteSize % BLOCK_SIZE)) % BLOCK_SIZE;
  }
  if (!sawEnd) throw new Error("The tar archive has no end marker.");
  for (; offset + BLOCK_SIZE <= tar.length; offset += BLOCK_SIZE) {
    if (!tar.subarray(offset, offset + BLOCK_SIZE).every((byte) => byte === 0)) {
      throw new Error("The tar archive has trailing non-zero blocks.");
    }
  }
  if ((tar.length % BLOCK_SIZE) !== 0 || offset !== tar.length) {
    throw new Error("The tar archive has trailing partial blocks.");
  }
  const required = [
    "package.json",
    "version.txt",
    "invokta.mcp.json",
    "apps/server/package.json",
    "apps/engine/package.json",
    "apps/engine/invokta.mcp.json",
  ];
  for (const name of required) {
    if (!seen.has(name)) {
      throw new Error(`The archive is missing required file ${name}.`);
    }
  }
  return {
    entries,
    sha256: createHash("sha256").update(archive).digest("hex"),
    byteSize: archive.length,
  };
}

export function buildDeterministicArtifact(
  input: BuildArtifactInput = {},
): ArtifactBuildResult {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const revision = input.revision ?? "HEAD";
  runGit(sourceRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const sources = selectSources(sourceRoot, revision);
  if (sources.length === 0) {
    throw new Error("No archive source files were selected.");
  }
  const archive = gzipSync(createTar(sources), { level: 9 });
  validateArtifact(archive);
  return {
    archive,
    sha256: createHash("sha256").update(archive).digest("hex"),
    byteSize: archive.length,
  };
}

export async function buildArtifactFile(
  outputPath: string,
  input: BuildArtifactInput = {},
): Promise<ArtifactBuildResult> {
  const result = buildDeterministicArtifact(input);
  await writeFile(outputPath, result.archive, { flag: "wx" });
  return result;
}

export async function validateArtifactFile(
  outputPath: string,
): Promise<ArtifactValidationResult> {
  return validateArtifact(await readFile(outputPath));
}
