import { argument } from "./cli-arguments.js";
import { assertReleaseVersionAgreement } from "../dist/release/versions.js";

const tag = argument("tag", process.env.RELEASE_TAG);
if (tag === undefined) {
  throw new Error(
    "Usage: node apps/server/scripts/verify-release-versions.mjs --tag=v1.0.0",
  );
}
console.log(JSON.stringify(await assertReleaseVersionAgreement({ tag })));
