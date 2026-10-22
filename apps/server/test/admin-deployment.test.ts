import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

function repositorySource(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function serverSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const deployEnvFixtures: string[] = [];

afterEach(() => {
  while (deployEnvFixtures.length > 0) {
    const directory = deployEnvFixtures.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function canonicalConfigurationKey(value: string): boolean {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

/**
 * Runs the production deploy script through the configuration-key backfill,
 * then exits before Compose. The VPS path is the only substitution; the
 * ensure function itself stays the production text.
 */
function runDeployEnvEnsure(existingEnv: string): {
  readonly env: Record<string, string>;
  readonly stdout: string;
  readonly mode: number;
} {
  const script = repositorySource("deploy/deploy.sh");
  expect(script).toContain("cd /opt/second-brain");
  const call = "ensure_configuration_encryption_key\n";
  expect(script).toContain(call);
  expect(script.indexOf(call)).toBeLessThan(script.indexOf("docker compose pull"));
  expect(script.indexOf(call)).toBeLessThan(script.indexOf("docker compose build"));

  const directory = mkdtempSync(path.join(tmpdir(), "second-brain-deploy-env-"));
  deployEnvFixtures.push(directory);
  writeFileSync(path.join(directory, ".env"), existingEnv, { mode: 0o644 });
  const patched = script
    .replace("cd /opt/second-brain", `cd ${JSON.stringify(directory)}`)
    .replace(call, `${call}exit 0\n`);
  expect(patched).not.toBe(script);

  const scriptPath = path.join(directory, "deploy.sh");
  writeFileSync(scriptPath, patched, { mode: 0o755 });
  const stdout = execFileSync("bash", [scriptPath], { encoding: "utf8" });
  const envPath = path.join(directory, ".env");
  const env = { ...parseEnv(readFileSync(envPath, "utf8")) } as Record<
    string,
    string
  >;
  return {
    env,
    stdout,
    mode: statSync(envPath).mode & 0o777,
  };
}

describe("admin deployment integration", () => {
  it("builds and ships the Vite application in the production image", () => {
    const dockerfile = repositorySource("Dockerfile");
    expect(dockerfile).toContain("AS admin-build");
    expect(dockerfile).toContain("apps/admin/package.json");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("/app/apps/admin/dist /app/admin-ui");
    expect(dockerfile).toContain("EXPOSE 3000 3001 3002");
  });

  it("runs the hardened admin service behind a path-specific Traefik router", () => {
    const compose = repositorySource("compose.yaml");
    expect(compose).toContain("admin:");
    expect(compose).toContain(
      '["node", "dist/services/admin/main.js"]',
    );
    expect(compose).toContain("PathPrefix(`/admin`)");
    expect(compose).toContain("PathPrefix(`/api/admin`)");
    expect(compose).not.toContain("PathPrefix(`/api/auth`)");
    expect(compose).toContain("traefik.http.services.second-brain-admin.loadbalancer.server.port=3002");
    expect(compose).toContain("SECOND_BRAIN_WORKER_ID: ${SECOND_BRAIN_WORKER_ID:-second-brain-automation-1}");
  });

  it("passes the configuration key to every model runtime", () => {
    const compose = repositorySource("compose.yaml");
    expect(compose).toContain("x-runtime-configuration-environment:");
    expect(compose.match(/\*runtime-configuration-environment/gu)).toHaveLength(4);
  });

  it("orchestrates the admin application through root workspace scripts", () => {
    const manifest = JSON.parse(repositorySource("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(manifest.scripts.build).toContain(
      "npm run build --workspace @second-brain/admin",
    );
    expect(manifest.scripts["admin:serve"]).toContain(
      "--workspace @second-brain/server",
    );
    expect(manifest.scripts.check).toContain(
      "npm run check --workspace @second-brain/admin",
    );
    expect(JSON.parse(serverSource("package.json")).scripts["admin:serve"]).toBe(
      "node dist/services/admin/main.js",
    );

    const environment = repositorySource(".env.example");
    for (const name of [
      "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY",
      "SECOND_BRAIN_PUBLIC_URL",
      "SECOND_BRAIN_ADMIN_PORT",
    ]) {
      expect(environment).toContain(`${name}=`);
    }
  });

  it("generates a missing configuration encryption key before Compose interpolates it", () => {
    const result = runDeployEnvEnsure(
      [
        "POSTGRES_PASSWORD=already-initialized",
        "OPENROUTER_API_KEY=sk-or-test",
        "SECOND_BRAIN_PUBLIC_URL=https://brain.example.com",
        "",
      ].join("\n"),
    );

    const key = result.env["SECOND_BRAIN_CONFIG_ENCRYPTION_KEY"];
    expect(typeof key).toBe("string");
    if (typeof key !== "string") throw new Error("expected configuration key");
    expect(canonicalConfigurationKey(key)).toBe(true);
    expect(result.env["POSTGRES_PASSWORD"]).toBe("already-initialized");
    expect(result.env["OPENROUTER_API_KEY"]).toBe("sk-or-test");
    expect(result.mode).toBe(0o600);
    expect(result.stdout).toMatch(/Generated SECOND_BRAIN_CONFIG_ENCRYPTION_KEY/);
    expect(result.stdout).not.toContain(key);
  });

  it("replaces an empty configuration encryption key and never rotates a real one", () => {
    const existing = Buffer.alloc(32, 9).toString("base64url");
    const kept = runDeployEnvEnsure(
      [
        "POSTGRES_PASSWORD=already-initialized",
        `SECOND_BRAIN_CONFIG_ENCRYPTION_KEY=${existing}`,
        "",
      ].join("\n"),
    );
    expect(kept.env["SECOND_BRAIN_CONFIG_ENCRYPTION_KEY"]).toBe(existing);
    expect(kept.stdout).not.toMatch(/Generated SECOND_BRAIN_CONFIG_ENCRYPTION_KEY/);

    const filled = runDeployEnvEnsure(
      [
        "POSTGRES_PASSWORD=already-initialized",
        "SECOND_BRAIN_CONFIG_ENCRYPTION_KEY=",
        "",
      ].join("\n"),
    );
    const key = filled.env["SECOND_BRAIN_CONFIG_ENCRYPTION_KEY"];
    expect(typeof key).toBe("string");
    if (typeof key !== "string") throw new Error("expected configuration key");
    expect(canonicalConfigurationKey(key)).toBe(true);
  });
});
