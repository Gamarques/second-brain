import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(projectRoot, "dist");

if (!existsSync(distDirectory) || !statSync(distDirectory).isDirectory()) {
  throw new Error("The dist directory is missing. Run the build before verifying artifacts.");
}

const forbiddenModulePrefixes = [
  "automation/dreaming-pricing.",
  "bin.",
  "capabilities/brain-ingest.",
  "cli.",
  "database/postgres-repository.",
  "mcp-stdio.",
  "oauth/bootstrap-owner.",
];
const forbiddenContent = [
  "DREAMING_INPUT_USD_PER_MILLION",
  "DREAMING_OUTPUT_USD_PER_MILLION",
  "INVOKTA_OAUTH_BOOTSTRAP_EMAIL",
  "INVOKTA_OAUTH_BOOTSTRAP_PASSWORD",
  "dailyCostLimitUsd",
  "costUsd",
];

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(absolute) : [absolute];
  });
}

const artifactFiles = filesIn(distDirectory);
const forbiddenModules = artifactFiles
  .map((file) => path.relative(distDirectory, file).split(path.sep).join("/"))
  .filter((relative) =>
    forbiddenModulePrefixes.some((prefix) => relative.startsWith(prefix)),
  );

if (forbiddenModules.length > 0) {
  throw new Error(`Removed modules remain in dist: ${forbiddenModules.join(", ")}`);
}

for (const file of artifactFiles) {
  if (!/\.(?:js|map)$/u.test(file)) continue;
  const content = readFileSync(file, "utf8");
  const forbidden = forbiddenContent.find((token) => content.includes(token));
  if (forbidden !== undefined) {
    throw new Error(
      `Removed configuration token ${forbidden} remains in ${path.relative(projectRoot, file)}.`,
    );
  }
}
