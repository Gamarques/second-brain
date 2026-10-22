import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  FORBIDDEN_ARCHIVE_ROOT,
  buildDeterministicArtifact,
  validateArtifact,
} from "../src/release/artifact.js";
import { assertReleaseVersionAgreement } from "../src/release/versions.js";
import { SECOND_BRAIN_VERSION } from "@second-brain/engine/version";

interface DrizzlePackageManifest {
  readonly version: string;
}

interface InvoktaManifest {
  readonly version: string;
}

interface ReleasePleaseManifest {
  readonly ".": string;
}

interface ReleasePleaseConfiguration {
  readonly "release-type": string;
  readonly "bootstrap-sha": string;
  readonly packages: {
    readonly ".": {
      readonly "release-type": string;
      readonly "include-component-in-tag": boolean;
      readonly "extra-files": readonly unknown[];
    };
  };
}

const temporaryDirectories: string[] = [];

function fixtureFile(root: string, relativePath: string, content = ""): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { flag: "wx" });
}

// Stage the symbolic link directly in the Git index (mode 120000) instead of
// creating it on disk. On Windows, `ln -s` from Git Bash/MSYS silently copies
// the target file, so the fixture would commit a regular file holding the
// secret content rather than a link, and the archive builder (which only sees
// the Git tree) has no way to know that file is a disguised secret.
function fixtureSymlink(root: string, target: string, name: string): void {
  const oid = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: target,
  })
    .toString("utf8")
    .trim();
  git(root, "update-index", "--add", "--cacheinfo", `120000,${oid},${name}`);
}

function git(root: string, ...arguments_: readonly string[]): void {
  execFileSync("git", ["-C", root, ...arguments_], { stdio: "pipe" });
}

async function createArchiveFixture(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), "second-brain-archive-"));
  temporaryDirectories.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");

  fixtureFile(
    root,
    "package.json",
    JSON.stringify({
      name: "@second-brain/workspace",
      private: true,
      workspaces: ["apps/*"],
    }),
  );
  fixtureFile(
    root,
    "apps/engine/package.json",
    JSON.stringify({
      name: "@second-brain/engine",
      version: "1.2.3",
      private: true,
    }),
  );
  fixtureFile(
    root,
    "apps/engine/invokta.mcp.json",
    JSON.stringify({ id: "second-brain", version: "1.2.3" }),
  );
  fixtureFile(
    root,
    "invokta.mcp.json",
    JSON.stringify({ id: "second-brain", version: "1.2.3" }),
  );
  fixtureFile(
    root,
    "apps/server/package.json",
    JSON.stringify({
      name: "@second-brain/server",
      version: "1.2.3",
      private: true,
    }),
  );
  fixtureFile(
    root,
    "release-please-manifest.json",
    JSON.stringify({ ".": "1.2.3" }),
  );
  fixtureFile(root, "version.txt", "1.2.3\n");
  fixtureFile(root, "AGENTS.md", "# Agent instructions\n");
  fixtureFile(root, ".agents/skills/example/SKILL.md", "# Example\n");
  fixtureFile(root, ".codex/config.toml", "model = \"test\"\n");
  fixtureFile(root, ".claude/intentional.json", "{}\n");
  fixtureFile(root, ".claude/worktrees/runtime.txt", "runtime\n");
  fixtureFile(root, ".claude/settings.local.json", "{}\n");
  fixtureFile(
    root,
    ".claude.json",
    '{"privateClaudeToken":"claude-state-leak"}\n',
  );
  fixtureFile(root, ".env", "PRIVATE_ENV=env-leak\n");
  fixtureFile(root, ".env.example", "SECRET=\n");
  fixtureFile(root, ".env.local", "PRIVATE_ENV=local-leak\n");
  fixtureFile(
    root,
    "credentials/service-account.json",
    '{"privateServiceAccount":"service-account-leak"}\n',
  );
  fixtureFile(root, ".installer-state.json", "{}\n");
  fixtureFile(root, "node_modules/dependency/index.js", "export {};\n");
  fixtureFile(root, "untracked-secret.txt", "not selected\n");
  fixtureSymlink(root, "AGENTS.md", "CLAUDE.md");
  fixtureSymlink(root, ".env", "leak-env");
  fixtureSymlink(root, ".claude.json", "leak-claude-state");
  fixtureSymlink(
    root,
    "credentials/service-account.json",
    "leak-service-account",
  );

  git(
    root,
    "add",
    "--force",
    "package.json",
    "apps/server/package.json",
    "apps/engine/package.json",
    "apps/engine/invokta.mcp.json",
    "invokta.mcp.json",
    "release-please-manifest.json",
    "version.txt",
    "AGENTS.md",
    ".agents",
    ".codex",
    ".claude",
    ".env",
    ".env.example",
    ".env.local",
    "credentials",
    ".installer-state.json",
    "node_modules",
    ".claude.json",
  );
  git(root, "commit", "-m", "fixture");
  return root;
}

function tarHeader(name: string, size: number, typeflag = "0"): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 100), 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tarBuffer(
  entries: readonly { readonly name: string; readonly content?: Buffer; readonly typeflag?: string }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    parts.push(tarHeader(entry.name, content.length, entry.typeflag));
    parts.push(content);
    parts.push(Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe("release artifacts", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.slice().reverse()) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("bootstraps Release Please and synchronizes both release manifests", async () => {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as DrizzlePackageManifest;
    const invoktaManifest = JSON.parse(
      readFileSync(
        new URL("../../engine/invokta.mcp.json", import.meta.url),
        "utf8",
      ),
    ) as InvoktaManifest;
    const engineManifest = JSON.parse(
      readFileSync(
        new URL("../../../apps/engine/package.json", import.meta.url),
        "utf8",
      ),
    ) as DrizzlePackageManifest;
    const engineInvoktaManifest = JSON.parse(
      readFileSync(
        new URL("../../../apps/engine/invokta.mcp.json", import.meta.url),
        "utf8",
      ),
    ) as InvoktaManifest;
    const rootInvoktaManifest = JSON.parse(
      readFileSync(new URL("../../../invokta.mcp.json", import.meta.url), "utf8"),
    ) as InvoktaManifest;
    const bootstrap = JSON.parse(
      readFileSync(
        new URL("../../../release-please-manifest.json", import.meta.url),
        "utf8",
      ),
    ) as ReleasePleaseManifest;
    const versionFile = readFileSync(
      new URL("../../../version.txt", import.meta.url),
      "utf8",
    ).trim();
    const configuration = JSON.parse(
      readFileSync(
        new URL("../../../release-please-config.json", import.meta.url),
        "utf8",
      ),
    ) as ReleasePleaseConfiguration;

    expect(packageManifest.version).toBe(SECOND_BRAIN_VERSION);
    expect(engineManifest.version).toBe(packageManifest.version);
    expect(engineInvoktaManifest.version).toBe(packageManifest.version);
    expect(rootInvoktaManifest.version).toBe(packageManifest.version);
    expect(invoktaManifest.version).toBe(packageManifest.version);
    expect(bootstrap).toEqual({ ".": packageManifest.version });
    expect(versionFile).toBe(packageManifest.version);
    expect(configuration["release-type"]).toBe("simple");
    expect(configuration["bootstrap-sha"]).toBe(
      "0d33276a91175d85b679c33f6eff81837b5b4d66",
    );
    expect(configuration.packages["."]["include-component-in-tag"]).toBe(false);
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "apps/engine/package.json",
      jsonpath: "$.version",
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "generic",
      path: "apps/engine/src/version.ts",
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "apps/server/package.json",
      jsonpath: "$.version",
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "apps/server/package.json",
      jsonpath: '$["dependencies"]["@second-brain/engine"]',
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "invokta.mcp.json",
      jsonpath: "$.version",
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "apps/engine/invokta.mcp.json",
      jsonpath: "$.version",
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "package-lock.json",
      jsonpath: '$["packages"]["apps/engine"]["version"]',
    });
    expect(configuration.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "package-lock.json",
      jsonpath:
        '$["packages"]["apps/server"]["dependencies"]["@second-brain/engine"]',
    });
    for (const extraFile of configuration.packages["."]["extra-files"]) {
      expect(extraFile).toEqual(expect.objectContaining({ path: expect.any(String) }));
      const configuredPath = (extraFile as { readonly path: string }).path;
      expect(path.isAbsolute(configuredPath)).toBe(false);
      expect(configuredPath.split("/")).not.toContain("..");
    }
  });

  it("builds a deterministic source archive with a security-conscious layout", async () => {
    const root = await createArchiveFixture();
    const first = buildDeterministicArtifact({ sourceRoot: root });
    const second = buildDeterministicArtifact({ sourceRoot: root });

    expect(Buffer.compare(first.archive, second.archive)).toBe(0);
    expect(createHash("sha256").update(first.archive).digest("hex")).toBe(
      first.sha256,
    );
    expect(first.byteSize).toBe(first.archive.length);

    const validation = validateArtifact(first.archive);
    expect(validation.byteSize).toBe(first.byteSize);
    expect(validation.sha256).toBe(first.sha256);
    expect(validation.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "package.json",
        "apps/server/package.json",
        "apps/engine/package.json",
        "apps/engine/invokta.mcp.json",
        "invokta.mcp.json",
        "version.txt",
        "AGENTS.md",
        "CLAUDE.md",
        ".env.example",
        ".agents/skills/example/SKILL.md",
        ".codex/config.toml",
        ".claude/intentional.json",
      ]),
    );
    const entryNames = validation.entries.map((entry) => entry.name);
    const forbiddenNames = new Set([
      ".env",
      ".env.local",
      `${FORBIDDEN_ARCHIVE_ROOT}/package.json`,
      ".claude/worktrees/runtime.txt",
      ".claude/settings.local.json",
      ".claude.json",
      "credentials/service-account.json",
      ".installer-state.json",
      "node_modules/dependency/index.js",
      "untracked-secret.txt",
      "leak-env",
      "leak-claude-state",
      "leak-service-account",
    ]);
    expect(entryNames.filter((name) => forbiddenNames.has(name))).toEqual([]);

    const tar = gunzipSync(first.archive);
    for (const secret of [
      "env-leak",
      "local-leak",
      "claude-state-leak",
      "service-account-leak",
    ]) {
      expect(tar.includes(Buffer.from(secret))).toBe(false);
    }
    expect(tar.includes(Buffer.from("# Agent instructions"))).toBe(true);
    // One `git` process per blob makes this slow on Windows (~5 s locally).
  }, 30_000);

  it("rejects unsafe and malformed tar entries", () => {
    const validName = "package.json";
    for (const entries of [
      [
        {
          name: `${FORBIDDEN_ARCHIVE_ROOT}/package.json`,
          content: Buffer.from("{}"),
        },
      ],
      [{ name: "/tmp/package.json" }],
      [{ name: "../escape" }],
      [
        { name: validName, content: Buffer.from("{}") },
        { name: validName },
      ],
      [{ name: "link", typeflag: "2" }],
      [{ name: "hard-link", typeflag: "1" }],
      [{ name: "directory/", typeflag: "5" }],
      [{ name: ".git/config" }],
      [{ name: ".env.production" }],
      [{ name: "node_modules/package/index.js" }],
      [{ name: ".claude/worktrees/runtime.txt" }],
      [{ name: "credentials/service-account.json" }],
    ]) {
      expect(() =>
        validateArtifact(gzipSync(tarBuffer(entries))),
      ).toThrow(/archive|path|entry/iu);
    }
  });

  it("rejects release tags that do not match every version manifest", async () => {
    const root = await createArchiveFixture();
    await expect(
      assertReleaseVersionAgreement({ sourceRoot: root, tag: "v1.2.4" }),
    ).rejects.toThrow("Release version mismatch");
  });

  it("rejects a root version file that disagrees with the release tag", async () => {
    const root = await createArchiveFixture();
    writeFileSync(path.join(root, "version.txt"), "1.2.4\n");

    await expect(
      assertReleaseVersionAgreement({ sourceRoot: root, tag: "v1.2.3" }),
    ).rejects.toThrow("Release version mismatch");
  });
});
