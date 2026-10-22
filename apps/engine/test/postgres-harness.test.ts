import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateTestDatabaseName } from "./integration/support/database.js";

describe("PostgreSQL integration harness safety", () => {
  it("only accepts explicitly prefixed disposable database names", () => {
    expect(validateTestDatabaseName("second_brain_test_schema_1")).toBe(
      "second_brain_test_schema_1",
    );

    for (const unsafeName of [
      "postgres",
      "second_brain",
      "second_brain_test",
      "second_brain_test_unsafe-name",
      'second_brain_test_safe"; DROP DATABASE postgres; --',
    ]) {
      expect(() => validateTestDatabaseName(unsafeName)).toThrow(
        "test database names must start with second_brain_test_",
      );
    }
  });

  it("uses temporary database storage and an isolated test database", async () => {
    const compose = await readFile(
      new URL("../../../compose.test.yaml", import.meta.url),
      "utf8",
    );

    expect(compose).toContain("name: second-brain-postgres-tests");
    expect(compose).toContain("image: pgvector/pgvector:0.8.2-pg15");
    expect(compose).toContain("POSTGRES_DB: second_brain_test_admin");
    expect(compose).toContain("/var/lib/postgresql/data");
    expect(compose).not.toContain("postgres-data");
    expect(compose).not.toMatch(/^volumes:/mu);
  });

  it("always asks Compose to remove the dedicated project and its volumes", async () => {
    const runner = await readFile(
      new URL("../scripts/run-postgres-tests.mjs", import.meta.url),
      "utf8",
    );

    expect(runner).toContain('"down", "--volumes", "--remove-orphans"');
    expect(runner).toContain("--project-name");
  });
});
