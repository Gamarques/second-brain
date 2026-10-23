import { configDefaults, defineConfig } from "vitest/config";

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
  test: {
    exclude: [
      ...configDefaults.exclude,
      "test/integration/**",
      // Live provider smoke tests need real credentials and run only on request.
      ...(process.env.OPENAI_COMPATIBLE_LIVE === "1" ? [] : ["test/live/**"]),
    ],
  },
});
