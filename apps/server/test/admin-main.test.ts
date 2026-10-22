import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeAdminProxyRequest,
  readAdminServerConfiguration,
} from "../src/services/admin/main.js";

describe("admin server composition configuration", () => {
  it("uses safe local defaults and accepts explicit deployment values", () => {
    const workspace = path.resolve("/workspace");
    expect(readAdminServerConfiguration({}, workspace)).toEqual({
      hostname: "127.0.0.1",
      port: 3_002,
      assetsDirectory: path.join(workspace, "admin-ui"),
    });

    expect(
      readAdminServerConfiguration(
        {
          SECOND_BRAIN_ADMIN_HOST: "0.0.0.0",
          SECOND_BRAIN_ADMIN_PORT: "4100",
          SECOND_BRAIN_ADMIN_ASSETS_DIR: "/srv/admin",
        },
        workspace,
      ),
    ).toEqual({
      hostname: "0.0.0.0",
      port: 4_100,
      assetsDirectory: "/srv/admin",
    });
  });

  it.each(["0", "65536", "3002x", " 3002"])(
    "rejects an invalid port %s",
    (port) => {
      expect(() =>
        readAdminServerConfiguration({ SECOND_BRAIN_ADMIN_PORT: port }),
      ).toThrow("SECOND_BRAIN_ADMIN_PORT is invalid.");
    },
  );
});

describe("admin reverse-proxy request normalization", () => {
  it("normalizes only an exact trusted forwarded origin", () => {
    const request = new Request("http://admin.example.com/api/admin/session", {
      headers: {
        host: "admin.example.com",
        "x-forwarded-host": "admin.example.com",
        "x-forwarded-proto": "https",
      },
    });

    const normalized = normalizeAdminProxyRequest(
      request,
      "https://admin.example.com",
    );
    expect(normalized.url).toBe("https://admin.example.com/api/admin/session");
  });

  it("leaves ambiguous or untrusted forwarding untouched", () => {
    const request = new Request("http://attacker.example/api/admin/session", {
      headers: {
        "x-forwarded-host": "admin.example.com, attacker.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(
      normalizeAdminProxyRequest(request, "https://admin.example.com"),
    ).toBe(request);
  });
});
