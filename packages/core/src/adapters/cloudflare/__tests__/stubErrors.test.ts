import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { translateStubError } from "../platform/stubErrors";

function caught(error: unknown): unknown {
  try {
    translateStubError(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("translateStubError must always throw");
}

describe("translateStubError", () => {
  it("maps an overloaded stub failure to ServiceOverloaded", () => {
    const error = caught(
      Object.assign(new Error("overloaded"), {
        overloaded: true,
      }),
    );
    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe(
      SystemErrorCode.ServiceOverloaded,
    );
    expect(isSystemError(error) && error.retryable).toBe(false);
  });

  it("maps any other stub failure to DatabaseError", () => {
    for (const input of [
      new Error("Durable Object reset because its code was updated"),
      new Error("The Durable Object's isolate exceeded its memory limit"),
      "abort",
      undefined,
    ]) {
      const error = caught(input);
      expect(isSystemError(error) && error.code).toBe(
        SystemErrorCode.DatabaseError,
      );
    }
  });

  it("does not map platform failures to ConflictError", () => {
    // A 409 tells the client "resubmit with fresh state"; that is false when
    // the DO could not be reached at all.
    const error = caught(new Error("Network connection lost"));
    expect(error).not.toHaveProperty("kind", "conflict");
    expect(isSystemError(error)).toBe(true);
  });

  it("treats a falsy `overloaded` marker as a plain failure", () => {
    const error = caught(
      Object.assign(new Error("nope"), { overloaded: false }),
    );
    expect(isSystemError(error) && error.code).toBe(
      SystemErrorCode.DatabaseError,
    );
  });
});
