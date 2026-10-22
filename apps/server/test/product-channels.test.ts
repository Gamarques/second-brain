import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(projectRoot, "../..");

function source(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

function repositorySource(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("product channels", () => {
  it("does not ship CLI or MCP stdio adapters", () => {
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/bin.ts"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/cli.ts"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "apps/engine/src/mcp-stdio.ts"))).toBe(false);

    const packageJson = JSON.parse(repositorySource("apps/engine/package.json")) as {
      readonly bin?: unknown;
      readonly scripts: Readonly<Record<string, string>>;
      readonly dependencies: Readonly<Record<string, string>>;
    };
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.scripts).not.toHaveProperty("cli");
    expect(packageJson.scripts).not.toHaveProperty("mcp:stdio");
    expect(packageJson.scripts).not.toHaveProperty("mcp:install");
    expect(packageJson.scripts).not.toHaveProperty("mcp:uninstall");
    expect(packageJson.dependencies).not.toHaveProperty("@invokta/cli");
    expect(packageJson.dependencies).not.toHaveProperty("@invokta/installer");
    expect(packageJson.scripts.build).toContain("npm run clean");

    // The Invokta framework requires a `server` block: @invokta/installer
    // rejects a manifest without one. It reads the block as a stdio transport
    // (`node <entrypoint>`), so the entrypoint must never name a stdio adapter
    // this product deliberately does not ship. It stays the HTTP adapter, and
    // installing through @invokta/installer is out of scope for this product.
    const mcpManifest = JSON.parse(
      repositorySource("apps/engine/invokta.mcp.json"),
    ) as {
      readonly server?: {
        readonly name?: unknown;
        readonly entrypoint?: unknown;
        readonly forwardEnv?: unknown;
      };
    };
    expect(mcpManifest.server?.entrypoint).toBe(
      "dist/mcp-http.js",
    );
    expect(mcpManifest.server?.entrypoint).not.toContain("stdio");
  });

  it("keeps direct and MCP HTTP on the shared engine boundary", () => {
    expect(repositorySource("apps/engine/src/direct.ts")).toContain(
      "runtime.engine.invoke(",
    );
    expect(repositorySource("apps/engine/src/mcp-http.ts")).toContain(
      "serveMcpHttp(runtime.engine",
    );
  });

  it("forwards the optional static bearer into the MCP HTTP engine", () => {
    const compose = repositorySource("compose.yaml");
    expect(compose).toContain(
      "INVOKTA_HTTP_BEARER_TOKEN: ${INVOKTA_HTTP_BEARER_TOKEN:-}",
    );
    expect(compose).toContain(
      "INVOKTA_HTTP_PRINCIPAL_ID: ${INVOKTA_HTTP_PRINCIPAL_ID:-}",
    );
  });

  it("waits for auth in build mode so owner bootstrap can create embedding spaces", () => {
    const script = repositorySource("deploy/deploy.sh");
    expect(script).toContain('MODE="${SECOND_BRAIN_DEPLOY_MODE:-registry}"');
    expect(script).toContain("wait-engine");
    expect(script).toContain(
      "deadlocks the installer, which bootstraps only after this script returns.",
    );
  });
});
