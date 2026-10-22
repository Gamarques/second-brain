import { defineConfig } from "vitest/config";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error(
    "PostgreSQL integration tests require TEST_DATABASE_ADMIN_URL. " +
      "Run them through scripts/run-postgres-tests.mjs to use the isolated Docker harness.",
  );
}

export default defineConfig({
  test: {
    env: {
      POSTGRES_INTEGRATION_TESTS: "1",
    },
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
