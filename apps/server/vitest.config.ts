import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const engineSource = fileURLToPath(new URL("../engine/src/", import.meta.url));

const integrationTestSelected = process.argv.some(
  (argument) =>
    /test[\\/]integration/u.test(argument) || argument.includes("migrations.test"),
);

if (integrationTestSelected && process.env.POSTGRES_INTEGRATION_TESTS !== "1") {
  throw new Error(
    "PostgreSQL integration tests must run through scripts/run-postgres-tests.mjs " +
      "or vitest.postgres.config.ts with TEST_DATABASE_ADMIN_URL set.",
  );
}

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@second-brain\/engine$/u,
        replacement: `${engineSource}engine.ts`,
      },
      {
        find: /^@second-brain\/engine\/(.+)$/u,
        replacement: `${engineSource}$1.ts`,
      },
    ],
  },
  test: {
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
