import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { argument } from "./cli-arguments.js";

const { buildDeterministicArtifact } = await import("../dist/release/artifact.js");
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "../..");
const sourceRoot = argument("source", repositoryRoot);
const revision = argument("revision", "HEAD");
const packageManifest = JSON.parse(
  await readFile(path.join(serverRoot, "package.json"), "utf8"),
);
const output = argument(
  "output",
  path.join(
    repositoryRoot,
    ".release",
    `second-brain-v${packageManifest.version}.tar.gz`,
  ),
);
const result = buildDeterministicArtifact({ sourceRoot, revision });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, result.archive);
await writeFile(
  `${output}.json`,
  JSON.stringify(
    { path: output, sha256: result.sha256, byteSize: result.byteSize },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    path: output,
    sha256: result.sha256,
    byteSize: result.byteSize,
  }),
);
