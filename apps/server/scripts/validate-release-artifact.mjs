import { readFile } from "node:fs/promises";

const archivePath = process.argv[2];
if (archivePath === undefined) {
  throw new Error(
    "Usage: node apps/server/scripts/validate-release-artifact.mjs <archive.tar.gz>",
  );
}
const { validateArtifact } = await import("../dist/release/artifact.js");
const result = validateArtifact(await readFile(archivePath));
console.log(
  JSON.stringify({
    path: archivePath,
    sha256: result.sha256,
    byteSize: result.byteSize,
    entries: result.entries,
  }),
);
