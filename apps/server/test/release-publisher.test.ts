import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  publishReleaseArtifact,
  type PublishArtifactInput,
} from "../src/release/publisher.js";

const temporaryDirectories: string[] = [];
const sha256 = "a".repeat(64);
const commitSha = "0".repeat(40);

interface MockResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}

function jsonResponse(value: unknown, status = 200): Response {
  const response: MockResponse = {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
  return response as Response;
}

function createInput(): {
  input: PublishArtifactInput;
  identity: Record<string, unknown>;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "second-brain-publisher-"));
  temporaryDirectories.push(directory);
  const archivePath = path.join(directory, "artifact.tar.gz");
  writeFileSync(archivePath, "artifact-bytes");
  const input = {
    apiBaseUrl: "https://api.example.com",
    oidcAudience: "installer-artifacts",
    oidcRequestUrl: "https://github.example/oidc?api-version=2.0",
    oidcRequestToken: "runtime-request-token",
    product: "second-brain",
    version: "1.0.0",
    commitSha,
    archivePath,
    sha256,
    byteSize: 13,
  } satisfies PublishArtifactInput;
  return {
    input,
    identity: {
      product: input.product,
      version: input.version,
      commitSha: input.commitSha,
      sha256: input.sha256,
      byteSize: input.byteSize,
    },
  };
}

function mockApi(activationValue: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://github.example/oidc")) {
      return jsonResponse({ value: "oidc-token" });
    }
    if (url === "https://api.example.com/api/internal/installer-artifacts") {
      return jsonResponse({
        objectKey: `products/second-brain/1.0.0/${sha256}.tar.gz`,
        uploadUrl: "https://storage.example.com/signed-upload",
      });
    }
    if (url === "https://storage.example.com/signed-upload") {
      return jsonResponse({});
    }
    if (
      url ===
      "https://api.example.com/api/internal/installer-artifacts/activate"
    ) {
      return jsonResponse(activationValue);
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  });
}

describe("release artifact publisher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.slice().reverse()) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("accepts the platform activation response and verifies identity fields", async () => {
    const { input, identity } = createInput();
    const fetchMock = mockApi({ activated: true, ...identity });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishReleaseArtifact(input);

    expect(result).toEqual({ activated: true, ...identity });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://storage.example.com/signed-upload",
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "PUT",
      headers: {
        "Content-Type": "application/gzip",
      },
      body: Buffer.from("artifact-bytes"),
    });
  });

  it("also accepts an explicit active status response", async () => {
    const { input, identity } = createInput();
    vi.stubGlobal(
      "fetch",
      mockApi({ status: "active", product: "second-brain", ...identity }),
    );

    await expect(publishReleaseArtifact(input)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("rejects an activated response with mismatched identity metadata", async () => {
    const { input, identity } = createInput();
    vi.stubGlobal(
      "fetch",
      mockApi({ activated: true, ...identity, version: "9.9.9" }),
    );

    await expect(publishReleaseArtifact(input)).rejects.toThrow(
      "mismatched version",
    );
  });

  it("rejects activation success without complete identity metadata", async () => {
    const { input } = createInput();
    vi.stubGlobal("fetch", mockApi({ activated: true }));

    await expect(publishReleaseArtifact(input)).rejects.toThrow(
      "missing product",
    );
  });

  it("rejects activation when one identity field is omitted", async () => {
    const { input, identity } = createInput();
    const partialIdentity = { ...identity };
    delete partialIdentity.byteSize;
    vi.stubGlobal(
      "fetch",
      mockApi({ activated: true, ...partialIdentity }),
    );

    await expect(publishReleaseArtifact(input)).rejects.toThrow(
      "missing byteSize",
    );
  });
});
