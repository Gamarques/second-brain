import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EngineStartupError } from "@second-brain/engine/env";
import { toBootstrapStartupError } from "../src/services/auth/bootstrap-failure.js";
import {
  ownerAlreadyExistsMessage,
  ownerCreatedPrefix,
  parseBootstrapCredentials,
  requirePipedBootstrapInput,
} from "../src/services/auth/bootstrap-piped.js";
import { requireInteractiveBootstrapTerminal } from "../src/services/auth/bootstrap-terminal.js";

const knownSentences = [
  "The database already contains an account.",
  "The bootstrap state is invalid.",
  "The bootstrap state does not match this request.",
  "The bootstrap state could not be finalized.",
  "An account with this email already exists.",
  "Initial embedding spaces could not be provisioned safely.",
  "The password must contain at least 12 characters.",
  "The password is too long.",
  "The password confirmation does not match.",
  "Account bootstrap requires an interactive terminal.",
  "Account bootstrap was cancelled.",
];

describe("toBootstrapStartupError", () => {
  it.each(knownSentences)("surfaces %j verbatim", (sentence) => {
    const mapped = toBootstrapStartupError(new Error(sentence));
    expect(mapped).toBeInstanceOf(EngineStartupError);
    expect((mapped as EngineStartupError).message).toBe(sentence);
  });

  it("maps an email validation failure to a stable sentence", () => {
    const schema = z.string().trim().toLowerCase().email().max(320);
    const result = schema.safeParse("not-an-email");
    expect(result.success).toBe(false);
    const mapped = toBootstrapStartupError(
      result.success ? new Error("unreachable") : result.error,
    );
    expect(mapped).toBeInstanceOf(EngineStartupError);
    expect((mapped as EngineStartupError).message).toBe(
      "The account email address is invalid.",
    );
  });

  it("returns unknown errors unchanged so they stay masked", () => {
    const original = new Error(
      'connect ECONNREFUSED 127.0.0.1:5432 password="secret"',
    );
    expect(toBootstrapStartupError(original)).toBe(original);
  });

  it("returns non-Error values unchanged", () => {
    expect(toBootstrapStartupError("boom")).toBe("boom");
    expect(toBootstrapStartupError(undefined)).toBe(undefined);
  });

  it("never wraps an unknown message even when it looks similar", () => {
    const original = new Error("The bootstrap state is invalid?");
    expect(toBootstrapStartupError(original)).toBe(original);
  });

  it("keeps the retired personal-brain sentence masked", () => {
    const original = new Error("The personal brain could not be created.");
    expect(toBootstrapStartupError(original)).toBe(original);
  });
});

describe("interactive account bootstrap", () => {
  it("accepts only an input and output TTY with raw-mode support", () => {
    expect(() =>
      requireInteractiveBootstrapTerminal(
        { isTTY: true, setRawMode: () => undefined },
        { isTTY: true },
      ),
    ).not.toThrow();
    expect(() =>
      requireInteractiveBootstrapTerminal(
        { isTTY: false, setRawMode: () => undefined },
        { isTTY: true },
      ),
    ).toThrow("Account bootstrap requires an interactive terminal.");
    expect(() =>
      requireInteractiveBootstrapTerminal(
        { isTTY: true, setRawMode: () => undefined },
        { isTTY: false },
      ),
    ).toThrow("Account bootstrap requires an interactive terminal.");
    expect(() =>
      requireInteractiveBootstrapTerminal({ isTTY: true }, { isTTY: true }),
    ).toThrow("Account bootstrap requires an interactive terminal.");
  });
});

describe("piped account bootstrap", () => {
  it("reads the email and password as the first two lines", () => {
    expect(parseBootstrapCredentials("owner@example.com\nsecret-passphrase\n")).toEqual({
      email: "owner@example.com",
      password: "secret-passphrase",
    });
  });

  it("keeps a password that contains spaces, colons, and trailing content", () => {
    expect(
      parseBootstrapCredentials("owner@example.com\n a: b #c \nignored\n").password,
    ).toBe(" a: b #c ");
  });

  it("accepts CRLF line endings without keeping the carriage return", () => {
    expect(parseBootstrapCredentials("owner@example.com\r\nsecret-passphrase\r\n")).toEqual({
      email: "owner@example.com",
      password: "secret-passphrase",
    });
  });

  it.each([
    ["no password line", "owner@example.com\n"],
    ["an empty password", "owner@example.com\n\n"],
    ["an empty email", "\nsecret-passphrase\n"],
    ["no input at all", ""],
  ])("fails closed for %s", (_label, input) => {
    expect(() => parseBootstrapCredentials(input)).toThrow(
      "Account bootstrap requires an email and password on standard input.",
    );
  });

  it("refuses a terminal so the password is never echoed", () => {
    expect(() => requirePipedBootstrapInput({ isTTY: false })).not.toThrow();
    expect(() => requirePipedBootstrapInput({})).not.toThrow();
    expect(() => requirePipedBootstrapInput({ isTTY: true })).toThrow(
      "Account bootstrap must not read credentials from a terminal.",
    );
  });

  it("publishes the result sentences the deployment installer matches on", () => {
    expect(ownerCreatedPrefix).toBe("OAuth owner created:");
    expect(ownerAlreadyExistsMessage).toBe("The OAuth owner account already exists.");
  });
});
