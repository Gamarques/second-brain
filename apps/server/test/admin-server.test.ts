import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdminServerApp } from "../src/services/admin/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function assets() {
  const directory = await mkdtemp(join(tmpdir(), "second-brain-admin-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><html><body>Second Brain Admin</body></html>",
  );
  await writeFile(join(directory, "app.js"), "globalThis.adminLoaded = true;");
  return directory;
}

describe("admin Hono server", () => {
  it("leaves OAuth routes to the existing authorization server", async () => {
    const app = createAdminServerApp({
      async adminHttp() { return new Response(null, { status: 404 }); },
      assetsDirectory: await assets(),
    });

    const response = await app.request(
      "https://brain.example.com/api/auth/sign-in/email",
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  it("mounts only the protected admin API", async () => {
    const adminHttp = vi.fn(async () => Response.json({ role: "owner" }));
    const app = createAdminServerApp({
      adminHttp,
      assetsDirectory: await assets(),
    });

    const admin = await app.request("https://brain.example.com/api/admin/session");
    expect(admin.status).toBe(200);
    expect(adminHttp).toHaveBeenCalledOnce();
  });

  it("serves built assets and falls back to index.html for SPA routes", async () => {
    const app = createAdminServerApp({
      async adminHttp() { return new Response(null, { status: 404 }); },
      assetsDirectory: await assets(),
    });

    const redirect = await app.request("https://brain.example.com/admin");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/admin/");

    const asset = await app.request("https://brain.example.com/admin/app.js");
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain("adminLoaded");

    const spa = await app.request(
      "https://brain.example.com/admin/knowledge/base-1/documents/document-1",
    );
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
    expect(spa.headers.get("cache-control")).toBe("no-store");
    await expect(spa.text()).resolves.toContain("Second Brain Admin");
  });
});
