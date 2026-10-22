import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function manifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("monorepo layout", () => {
  it("keeps the repository root as a workspace orchestrator", () => {
    const root = manifest("package.json");

    expect(root.workspaces).toEqual(["apps/*"]);
    expect(root).not.toHaveProperty("dependencies");
    expect(root.devDependencies).toEqual({
      jsdom: "27.0.1",
      vitest: "4.1.11",
    });
    for (const packageOwnedDirectory of [
      "dist",
      "drizzle",
      "scripts",
      "src",
      "test",
    ]) {
      expect(
        existsSync(resolve(repositoryRoot, packageOwnedDirectory)),
        packageOwnedDirectory,
      ).toBe(false);
    }
  });

  it("places applications and the engine in explicit workspaces", () => {
    const server = manifest("apps/server/package.json");
    const admin = manifest("apps/admin/package.json");
    const engine = manifest("apps/engine/package.json");

    expect(server.name).toBe("@second-brain/server");
    expect(admin.name).toBe("@second-brain/admin");
    expect(engine.name).toBe("@second-brain/engine");
    expect(server.private).toBe(true);
    expect(admin.private).toBe(true);
    expect(engine.private).toBe(true);
    expect(server.dependencies).toMatchObject({
      "@second-brain/engine": engine.version,
    });
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/engine.ts"))).toBe(
      true,
    );
    expect(
      existsSync(resolve(repositoryRoot, "apps/engine/invokta.mcp.json")),
    ).toBe(true);
    expect(existsSync(resolve(repositoryRoot, "apps/engine/test"))).toBe(true);
    expect(
      existsSync(
        resolve(repositoryRoot, "apps/engine/test/integration/migrations.test.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(repositoryRoot, "apps/server/test/integration/migrations.test.ts"),
      ),
    ).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/direct.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/mcp-http.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/http-auth.ts"))).toBe(
      true,
    );
    expect(
      existsSync(resolve(repositoryRoot, "packages/engine")),
    ).toBe(false);
    expect(engine.scripts).toMatchObject({
      "check:mcp": "invokta check-mcp ./dist/engine.js",
      "deploy:package": "npm run deploy:package --prefix ../..",
      test: "vitest run test",
      "test:postgres": "node scripts/run-postgres-tests.mjs",
    });
    const rootInstallerManifest = manifest("invokta.mcp.json") as {
      readonly id: string;
      readonly version: string;
      readonly capabilityIds: readonly string[];
      readonly server: {
        readonly entrypoint: string;
        readonly forwardEnv: readonly string[];
      };
    };
    const engineManifest = manifest("apps/engine/invokta.mcp.json") as {
      readonly id: string;
      readonly version: string;
      readonly capabilityIds: readonly string[];
      readonly server: { readonly forwardEnv: readonly string[] };
    };
    expect(rootInstallerManifest.id).toBe(engineManifest.id);
    expect(rootInstallerManifest.version).toBe(engineManifest.version);
    expect(rootInstallerManifest.capabilityIds).toEqual(
      engineManifest.capabilityIds,
    );
    expect(rootInstallerManifest.server).toMatchObject({
      entrypoint: "apps/engine/dist/mcp-http.js",
    });
    expect(rootInstallerManifest.server.forwardEnv).toContain(
      "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY",
    );
    expect(engineManifest.server.forwardEnv).toContain(
      "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY",
    );
    const deployManifest = manifest("apps/engine/invokta.deploy.json") as {
      readonly env?: { readonly required?: readonly string[] };
    };
    expect(deployManifest.env?.required).toContain(
      "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY",
    );
    expect(existsSync(resolve(repositoryRoot, "apps/server/test"))).toBe(true);
    expect(existsSync(resolve(repositoryRoot, "apps/engine/drizzle"))).toBe(true);
  });

  it("checks out the deployment contract that matches a rollback image", () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/deploy.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      'description: "Commit SHA image to deploy (rollback). Empty = build HEAD and deploy it."',
    );
    expect(workflow).toContain("Validate rollback commit SHA");
    expect(workflow).toContain("ref: ${{ inputs.image_tag || github.sha }}");
    expect(workflow).toContain("scp compose.yaml deploy/deploy.sh");
  });

  it("separates the Invokta app from auxiliary backend services", () => {
    for (const service of ["admin", "auth", "automation"]) {
      expect(
        existsSync(
          resolve(repositoryRoot, `apps/server/src/services/${service}/main.ts`),
        ),
        service,
      ).toBe(true);
    }

    for (const formerRootAdapter of [
      "admin-engine.ts",
      "admin-http.ts",
      "admin-main.ts",
      "admin-server.ts",
      "automation-worker.ts",
      "http-auth.ts",
      "mcp-http.ts",
      "oauth-server.ts",
    ]) {
      expect(
        existsSync(resolve(repositoryRoot, `apps/server/src/${formerRootAdapter}`)),
        formerRootAdapter,
      ).toBe(false);
    }

    for (const engineInfrastructure of [
      "database",
      "providers",
      "runtime.ts",
      "direct.ts",
      "mcp-http.ts",
      "http-auth.ts",
    ]) {
      expect(
        existsSync(resolve(repositoryRoot, `apps/engine/src/${engineInfrastructure}`)),
        engineInfrastructure,
      ).toBe(true);
    }
    for (const engineOnlyPath of [
      "database",
      "providers",
      "direct.ts",
      "mcp-http.ts",
      "http-auth.ts",
    ]) {
      expect(
        existsSync(resolve(repositoryRoot, `apps/server/src/${engineOnlyPath}`)),
        engineOnlyPath,
      ).toBe(false);
    }
    for (const engineOwnedPath of ["capabilities", "domain", "engine.ts"]) {
      expect(
        existsSync(resolve(repositoryRoot, `apps/server/src/${engineOwnedPath}`)),
        engineOwnedPath,
      ).toBe(false);
      expect(
        existsSync(resolve(repositoryRoot, `apps/engine/src/${engineOwnedPath}`)),
        engineOwnedPath,
      ).toBe(true);
    }
  });

  it("uses one repository lockfile for all workspaces", () => {
    expect(existsSync(resolve(repositoryRoot, "package-lock.json"))).toBe(true);
    const lockfile = manifest("package-lock.json") as {
      readonly packages?: Readonly<Record<string, unknown>>;
    };
    expect(lockfile.packages).not.toHaveProperty("packages/engine");
    expect(existsSync(resolve(repositoryRoot, "apps/server/package-lock.json"))).toBe(
      false,
    );
    expect(existsSync(resolve(repositoryRoot, "apps/admin/package-lock.json"))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repositoryRoot, "apps/engine/package-lock.json")),
    ).toBe(false);
  });
});
