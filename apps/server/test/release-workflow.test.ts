import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const publisher = readFileSync(
  new URL("../src/release/publisher.ts", import.meta.url),
  "utf8",
);

describe("release publication workflow", () => {
  it("publishes in the same run that creates the GitHub release", () => {
    expect(workflow).toContain("needs: release-please");
    expect(workflow).toContain(
      "if: needs.release-please.outputs.release_created == 'true'",
    );
    expect(workflow).toContain("id-token: write");
  });

  it("checks the exact release and builds a validated archive", () => {
    expect(workflow).toContain(
      "release_sha: ${{ steps.release.outputs.sha }}",
    );
    expect(workflow).toContain(
      "ref: ${{ needs.release-please.outputs.tag_name }}",
    );
    expect(workflow).not.toContain("git fetch");
    expect(workflow).toContain('test "$tag_sha" = "$RELEASE_SHA"');
    expect(workflow).toContain('test "$head_sha" = "$RELEASE_SHA"');
    expect(workflow).toContain("run: npm ci && npm run check");
    expect(workflow).toContain("npm run release:verify-versions");
    expect(workflow).toContain("npm run artifact:build");
    expect(workflow).toContain('--revision="$RELEASE_SHA"');
    expect(workflow).toContain("npm run artifact:validate");
    expect(workflow).toMatch(/createHash\("sha256"\)/u);
  });

  it("uses the internal OIDC artifact API without bucket credentials", () => {
    for (const endpoint of [
      "/api/internal/installer-artifacts",
      "/api/internal/installer-artifacts/activate",
    ]) {
      expect(publisher).toContain(endpoint);
    }
    expect(publisher).toContain("fetch(uploadUrl");
    expect(publisher).toContain("method: \"PUT\"");
    expect(publisher).toContain("descriptor.activated !== true");
    expect(workflow).toContain("vars.INSTALLER_ARTIFACT_API_URL");
    expect(workflow).toContain("vars.INSTALLER_ARTIFACT_OIDC_AUDIENCE");
    expect(workflow).not.toMatch(/(?:BUCKET|STORAGE|AWS)_?[A-Z_]*(?:SECRET|KEY|TOKEN)/u);
  });

  it("pins every third-party action to an immutable SHA", () => {
    const uses = [...workflow.matchAll(/uses: ([^\n]+)/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use).toMatch(/@[0-9a-f]{40}(?:\s+#)/u);
    }
  });
});
