import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(projectRoot, "src");
const engineSourceRoot = resolve(projectRoot, "../engine/src");

function walkTypeScriptFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return walkTypeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

const productionFiles = [
  ...walkTypeScriptFiles(sourceRoot),
  ...walkTypeScriptFiles(engineSourceRoot),
];

function projectPath(path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

function locations(
  path: string,
  source: string,
  pattern: RegExp,
): readonly string[] {
  const matches: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    matches.push(`${projectPath(path)}:${line}`);
  }
  return matches;
}

function findText(pattern: RegExp): readonly string[] {
  return productionFiles.flatMap((path) =>
    locations(path, readFileSync(path, "utf8"), pattern),
  );
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isSchemaOrMigrationExpression(path: string): boolean {
  const normalized = projectPath(path);
  return (
    normalized.startsWith("src/database/schema/") ||
    normalized.startsWith("../engine/src/database/schema/") ||
    normalized === "src/database/migrate.ts" ||
    normalized === "../engine/src/database/migrate.ts"
  );
}

const fullRawCrud =
  /\b(?:select\s+[\s\S]+?\s+from|insert\s+into|update\s+[a-z_][a-z0-9_]*\s+set|delete\s+from)\b/giu;

function rawCrudLocations(): readonly string[] {
  const matches: string[] = [];

  for (const path of productionFiles) {
    if (isSchemaOrMigrationExpression(path)) continue;
    matches.push(...locations(path, readFileSync(path, "utf8"), fullRawCrud));
  }

  return matches;
}

function directPostgresQueryLocations(): readonly string[] {
  return productionFiles.flatMap((path) => {
    if (
      projectPath(path) === "src/database/migrate.ts" ||
      projectPath(path) === "../engine/src/database/migrate.ts"
    ) {
      return [];
    }
    return locations(
      path,
      readFileSync(path, "utf8"),
      /\b(?:pool|client)\.query\s*\(/gu,
    );
  });
}

function importTimeEngineLocations(): readonly string[] {
  // The conventional `engine` export in the MCP service is the Invokta
  // composition-root contract that devtools and deploy load; every other
  // module must reach the engine through the validated runtime instead of a
  // shared import-time binding.
  return [
    ...findText(/^(?:export\s+)?const\s+engine\s*=/gmu).filter(
      (location) =>
        !location.startsWith("src/services/mcp/engine.ts:") &&
        !location.startsWith("../engine/src/engine.ts:"),
    ),
    ...findText(
      /import\s*\{\s*engine\s*\}\s*from\s*["'][^"']*engine[^"']*["']/gu,
    ),
    ...findText(/const\s*\{\s*engine\s*\}\s*=\s*await\s+import\s*\(/gu),
  ];
}

function deploymentConfigurationFiles(): readonly string[] {
  return readdirSync(projectRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === "package.json" ||
          entry.name === "Dockerfile" ||
          /^compose(?:\..+)?\.ya?ml$/u.test(entry.name)),
    )
    .map((entry) => resolve(projectRoot, entry.name));
}

describe("clean v1 architecture", () => {
  it("contains no owner-scoped or monolithic repository vocabulary", () => {
    const violations = [
      ...findText(/\bownerId\b/gu),
      ...findText(/\bowner_id\b/gu),
      ...findText(
        /\b(?:SecondBrainRepository|PostgresSecondBrainRepository)\b/gu,
      ),
    ];

    expect(sortedUnique(violations)).toEqual([]);
  });

  it("uses Drizzle for production CRUD", () => {
    const pooledQueries = findText(/\bpool\.query\s*\(/gu);
    expect(
      sortedUnique([
        ...pooledQueries,
        ...directPostgresQueryLocations(),
        ...rawCrudLocations(),
      ]),
    ).toEqual([]);
  });

  it("does not expose the legacy ingestion capability", () => {
    expect(findText(/\bbrain_ingest\b/gu)).toEqual([]);
  });

  it("contains no persisted or transported brain identifier", () => {
    const inputGuardPrefix =
      "../engine/src/capabilities/define.ts:";
    expect(
      sortedUnique([
        ...findText(/\bbrainId\b/gu).filter(
          (location) => !location.startsWith(inputGuardPrefix),
        ),
        ...findText(/\bbrain_id\b/gu),
      ]),
    ).toEqual([]);
  });

  it("constructs the shared engine only in the conventional composition root", () => {
    expect(sortedUnique(importTimeEngineLocations())).toEqual([]);
  });

  it("contains no legacy bootstrap entry point", () => {
    const violations = [
      ...findText(/\bbootstrap-owner\b/gu),
      ...deploymentConfigurationFiles().flatMap((path) =>
        locations(path, readFileSync(path, "utf8"), /\bbootstrap-owner\b/gu),
      ),
    ];
    expect(sortedUnique(violations)).toEqual([]);
  });

  it("has removed the legacy raw PostgreSQL repository", () => {
    const legacyRepository = resolve(
      sourceRoot,
      "database/postgres-repository.ts",
    );
    expect(existsSync(legacyRepository), basename(legacyRepository)).toBe(
      false,
    );
  });

  it("does not hash actor identity into task or reminder idempotency digests", () => {
    const storePaths = [
      resolve(engineSourceRoot, "database/stores/task-store.ts"),
      resolve(engineSourceRoot, "database/stores/reminder-store.ts"),
    ];

    for (const path of storePaths) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/\bactorDigest\b/gu);
      for (const recipe of source.matchAll(
        /const requestDigest = digest\(\{([\s\S]*?)\n\s*\}\);/gu,
      )) {
        expect(recipe[1], projectPath(path)).not.toMatch(
          /\b(?:accountId|clientId|actor)\s*:/gu,
        );
      }
    }
  });
});
