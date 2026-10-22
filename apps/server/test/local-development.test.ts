import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("local full-stack development", () => {
  it("exposes one root command for the complete development stack", () => {
    const manifest = JSON.parse(source("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(manifest.scripts.dev).toBe("node tools/local-dev.mjs up");
    expect(manifest.scripts["dev:bootstrap"]).toBe(
      "node tools/local-dev.mjs bootstrap",
    );
    expect(manifest.scripts["dev:logs"]).toBe(
      "node tools/local-dev.mjs logs",
    );
    expect(manifest.scripts["dev:down"]).toBe(
      "node tools/local-dev.mjs down",
    );
  });

  it("isolates generated local credentials and the development database", () => {
    const runner = source("tools/local-dev.mjs");
    const ignore = source(".gitignore");

    expect(ignore).toContain(".env.development");
    expect(runner).toContain('randomBytes(32).toString("base64url")');
    expect(runner).toContain('flag: "wx"');
    expect(runner).toContain('mode: 0o600');
    expect(runner).toContain('"--project-name", projectName');
    expect(runner).toContain('"--env-file", baseEnvironmentFile');
    expect(runner).toContain('"--env-file", developmentEnvironmentFile');
    expect(runner).not.toMatch(/console\.(?:log|error)\([^\n]*(?:password|key)/iu);
  });

  it("serves OAuth, MCP, and admin through one loopback origin", () => {
    const compose = source("compose.dev.yaml");
    const nginx = source("deploy/local-nginx-main.conf");
    const proxy = source("deploy/local-nginx.conf");
    const runner = source("tools/local-dev.mjs");

    expect(compose).toContain(
      "http://127.0.0.1:${SECOND_BRAIN_DEV_PORT:-8080}",
    );
    expect(compose).not.toContain("http://localhost:");
    expect(compose.match(/SECOND_BRAIN_PUBLIC_URL:/gu)).toHaveLength(3);
    expect(compose).toContain("local-edge:");
    expect(compose).toContain("127.0.0.1:${SECOND_BRAIN_DEV_PORT:-8080}:8080");
    expect(runner).toContain(
      "const publicOrigin = `http://127.0.0.1:${development.SECOND_BRAIN_DEV_PORT}`",
    );
    expect(runner).toContain('SECOND_BRAIN_PUBLIC_HOST: "127.0.0.1"');
    expect(proxy).toContain("proxy_pass http://second_brain_admin");
    expect(proxy).toContain("proxy_pass http://second_brain_engine");
    expect(proxy).toContain("proxy_pass http://second_brain_auth");
    expect(compose).toContain("user: nginx");
    expect(compose).toContain(
      "./deploy/local-nginx-main.conf:/etc/nginx/nginx.conf:ro",
    );
    expect(nginx).toContain("pid /tmp/nginx.pid;");
    expect(nginx).toContain("proxy_temp_path /tmp/proxy_temp;");
    expect(nginx).toContain("fastcgi_temp_path /tmp/fastcgi_temp;");
    expect(nginx).toContain("uwsgi_temp_path /tmp/uwsgi_temp;");
    expect(nginx).toContain("scgi_temp_path /tmp/scgi_temp;");
    expect(nginx).toContain(
      "map $http_host $second_brain_canonical_host",
    );
    expect(nginx).toContain("resolver 127.0.0.11 valid=1s ipv6=off;");
    expect(nginx).toContain("server admin:3002 resolve;");
    expect(nginx).toContain("server engine:3000 resolve;");
    expect(nginx).toContain("server auth:3001 resolve;");
    expect(proxy).toContain(
      "return 308 http://$second_brain_canonical_host$request_uri;",
    );
  });

  it("places the built admin assets at the path configured in Compose", () => {
    const dockerfile = source("Dockerfile");
    const compose = source("compose.yaml");

    expect(dockerfile).toContain("/app/apps/admin/dist /app/admin-ui");
    expect(compose).toContain(
      "SECOND_BRAIN_ADMIN_ASSETS_DIR: /app/admin-ui",
    );
  });
});
