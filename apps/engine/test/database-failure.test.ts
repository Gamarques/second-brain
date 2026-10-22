import { describe, expect, it } from "vitest";

import { toDatabaseStartupError } from "../src/database/failure.js";
import { EngineStartupError } from "../src/env.js";

function pgError(code: string, message = "database error"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("toDatabaseStartupError", () => {
  it("maps an authentication failure to the password sentence", () => {
    const mapped = toDatabaseStartupError(
      pgError("28P01", 'password authentication failed for user "second_brain"'),
    );
    expect(mapped).toBeInstanceOf(EngineStartupError);
    expect((mapped as EngineStartupError).message).toBe(
      "The database rejected the password; POSTGRES_PASSWORD does not match the initialized database volume.",
    );
  });

  it("maps invalid authorization the same way", () => {
    const mapped = toDatabaseStartupError(pgError("28000"));
    expect(mapped).toBeInstanceOf(EngineStartupError);
  });

  it("maps an unreachable database", () => {
    const mapped = toDatabaseStartupError(pgError("ECONNREFUSED"));
    expect(mapped).toBeInstanceOf(EngineStartupError);
    expect((mapped as EngineStartupError).message).toBe(
      "The database is not reachable.",
    );
  });

  it("maps a missing database", () => {
    const mapped = toDatabaseStartupError(pgError("3D000"));
    expect(mapped).toBeInstanceOf(EngineStartupError);
    expect((mapped as EngineStartupError).message).toBe(
      "The database does not exist.",
    );
  });

  it("maps missing embedding spaces to a bootstrap sentence", () => {
    const mapped = toDatabaseStartupError(
      pgError("ACTIVE_EMBEDDING_SPACE_MISMATCH"),
    );
    expect(mapped).toBeInstanceOf(EngineStartupError);
    expect((mapped as EngineStartupError).message).toMatch(/Bootstrap the owner account/);
  });

  it("returns unknown errors unchanged so they stay masked", () => {
    const original = pgError("XX000", "secret detail");
    expect(toDatabaseStartupError(original)).toBe(original);
    expect(toDatabaseStartupError("boom")).toBe("boom");
  });
});
