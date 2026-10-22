import { readFile } from "node:fs/promises";

import { argument } from "./cli-arguments.js";
import { publishReleaseArtifact } from "../dist/release/publisher.js";

const apiBaseUrl = process.env.INSTALLER_ARTIFACT_API_URL;
const oidcAudience = process.env.INSTALLER_ARTIFACT_OIDC_AUDIENCE;
const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const archivePath = argument("archive");
const version = argument("version");
const commitSha = argument("commit-sha", process.env.GITHUB_SHA);
const product = argument("product", "second-brain");

if (
  archivePath === undefined ||
  version === undefined ||
  commitSha === undefined ||
  apiBaseUrl === undefined ||
  oidcAudience === undefined ||
  oidcRequestUrl === undefined ||
  oidcRequestToken === undefined
) {
  throw new Error(
    "Required publication inputs are missing. Set the GitHub variables and OIDC runtime environment.",
  );
}

const summary = JSON.parse(await readFile(`${archivePath}.json`, "utf8"));
const descriptor = await publishReleaseArtifact({
  apiBaseUrl,
  oidcAudience,
  oidcRequestUrl,
  oidcRequestToken,
  product,
  version,
  commitSha,
  archivePath,
  sha256: summary.sha256,
  byteSize: summary.byteSize,
});
console.log(JSON.stringify(descriptor));
