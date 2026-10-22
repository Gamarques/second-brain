import { readFile } from "node:fs/promises";
import path from "node:path";

const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface ReleaseVersionInput {
  readonly sourceRoot?: string;
  readonly tag?: string;
}

export interface ReleaseVersions {
  readonly tag: string;
  readonly versionFile: string;
  readonly packageJson: string;
  readonly enginePackageJson: string;
  readonly rootInvoktaMcpJson: string;
  readonly engineInvoktaMcpJson: string;
  readonly invoktaMcpJson: string;
  readonly releasePleaseManifest: string;
}

async function readJson(root: string, relativePath: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${relativePath} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function readVersion(root: string, relativePath: string): Promise<string> {
  const value = await readJson(root, relativePath);
  const version = value.version;
  if (typeof version !== "string" || !SEMANTIC_VERSION.test(version)) {
    throw new Error(`${relativePath} must contain a valid semantic version.`);
  }
  return version;
}

async function readVersionFile(root: string, relativePath: string): Promise<string> {
  const version = (
    await readFile(path.join(root, relativePath), "utf8")
  ).trim();
  if (!SEMANTIC_VERSION.test(version)) {
    throw new Error(`${relativePath} must contain a valid semantic version.`);
  }
  return version;
}

export async function assertReleaseVersionAgreement(
  input: ReleaseVersionInput = {},
): Promise<ReleaseVersions> {
  const root = input.sourceRoot ?? process.cwd();
  const tag = input.tag;
  if (tag === undefined || !/^v[0-9]/u.test(tag)) {
    throw new Error("A release tag starting with 'v' is required.");
  }
  const expected = tag.slice(1);
  if (!SEMANTIC_VERSION.test(expected)) {
    throw new Error(`The release tag ${tag} is not a valid semantic version tag.`);
  }
  const versionFile = await readVersionFile(root, "version.txt");
  const packageJson = await readVersion(root, "apps/server/package.json");
  const enginePackageJson = await readVersion(
    root,
    "apps/engine/package.json",
  );
  const rootInvoktaMcpJson = await readVersion(root, "invokta.mcp.json");
  const engineInvoktaMcpJson = await readVersion(
    root,
    "apps/engine/invokta.mcp.json",
  );
  const invoktaMcpJson = engineInvoktaMcpJson;
  const manifest = await readJson(root, "release-please-manifest.json");
  const releasePleaseManifest = manifest["."];
  if (typeof releasePleaseManifest !== "string") {
    throw new Error(
      "release-please-manifest.json must bootstrap the root release to a version.",
    );
  }
  if (
    versionFile !== expected ||
    packageJson !== expected ||
    enginePackageJson !== expected ||
    rootInvoktaMcpJson !== expected ||
    engineInvoktaMcpJson !== expected ||
    invoktaMcpJson !== expected ||
    releasePleaseManifest !== expected
  ) {
    throw new Error(
      `Release version mismatch: tag=${expected}, version.txt=${versionFile}, ` +
        `apps/server/package.json=${packageJson}, ` +
        `apps/engine/package.json=${enginePackageJson}, ` +
        `invokta.mcp.json=${rootInvoktaMcpJson}, ` +
        `apps/engine/invokta.mcp.json=${engineInvoktaMcpJson}, ` +
        `release-please-manifest.json=${releasePleaseManifest}.`,
    );
  }
  return {
    tag,
    versionFile,
    packageJson,
    enginePackageJson,
    rootInvoktaMcpJson,
    engineInvoktaMcpJson,
    invoktaMcpJson,
    releasePleaseManifest,
  };
}
