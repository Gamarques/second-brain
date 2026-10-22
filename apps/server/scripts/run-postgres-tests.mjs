import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "../..");
const composeFile = path.join(repositoryRoot, "compose.test.yaml");
const vitestEntry = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const providedAdminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const projectName = `second-brain-postgres-tests-${process.pid}-${randomBytes(4).toString("hex")}`;
const composeArgs = [
  "compose",
  "--file",
  composeFile,
  "--project-name",
  projectName,
];

let activeChild;
let composeStarted = false;
let cleaningUp = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChild = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          `${command} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}${detail ? `:\n${detail}` : ""}`,
        ),
      );
    });
  });
}

async function assertDockerAvailable() {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"], {
      capture: true,
    });
    await run("docker", ["compose", "version", "--short"], {
      capture: true,
    });
  } catch (error) {
    throw new Error(
      "PostgreSQL integration tests need a working Docker daemon or TEST_DATABASE_ADMIN_URL pointing to a disposable PostgreSQL instance.",
      { cause: error },
    );
  }
}

async function cleanup() {
  if (!composeStarted || cleaningUp) return;
  cleaningUp = true;
  try {
    await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], {
      capture: true,
    });
  } catch (error) {
    process.stderr.write(`Failed to clean the PostgreSQL test project: ${error.message}\n`);
    process.exitCode = process.exitCode || 1;
  } finally {
    cleaningUp = false;
    composeStarted = false;
  }
}

async function composeAdminUrl() {
  await assertDockerAvailable();
  composeStarted = true;
  try {
    await run("docker", [...composeArgs, "up", "--detach", "--wait"], {
      capture: true,
    });
  } catch (error) {
    const logs = await run(
      "docker",
      [...composeArgs, "logs", "--no-color", "postgres"],
      { capture: true },
    ).catch(() => ({ stdout: "", stderr: "" }));
    const detail = logs.stdout || logs.stderr;
    throw new Error(
      `The isolated PostgreSQL container did not become healthy.${detail ? `\n${detail}` : ""}`,
      { cause: error },
    );
  }
  const { stdout } = await run(
    "docker",
    [...composeArgs, "port", "postgres", "5432"],
    { capture: true },
  );
  const match = stdout.match(/:(\d+)$/u);
  if (!match) {
    throw new Error(`Could not determine the PostgreSQL test port from: ${stdout}`);
  }
  return `postgresql://second_brain_test:second_brain_test@127.0.0.1:${match[1]}/second_brain_test_admin`;
}

async function main() {
  let adminUrl = providedAdminUrl;
  try {
    if (!adminUrl) adminUrl = await composeAdminUrl();
    const result = await run(
      process.execPath,
      [
        vitestEntry,
        "run",
        "--config",
        path.join(serverRoot, "vitest.postgres.config.ts"),
        ...process.argv.slice(2),
      ],
      {
        env: { ...process.env, TEST_DATABASE_ADMIN_URL: adminUrl },
        cwd: serverRoot,
      },
    );
    void result;
  } finally {
    await cleanup();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    activeChild?.kill(signal);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
