import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { serializeError } from "../errorResponse";
import { endSession } from "../session";
import { SESSION_COOKIE_NAME } from "../sessionCookie";

describe("endSession", () => {
  // TC-logout-002
  it("writes the expiry cookie through the header sink (TC-logout-002)", () => {
    const written: string[] = [];
    endSession((value) => {
      written.push(value);
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(written[0]).toContain("Max-Age=0");
  });

  // TC-logout-003
  it("translates a failing header write into SystemError(SESSION_ERROR) (TC-logout-003)", () => {
    const cause = new Error("response already committed");

    let caught: unknown;
    try {
      endSession(() => {
        throw cause;
      });
    } catch (error) {
      caught = error;
    }

    expect(isSystemError(caught)).toBe(true);
    expect(isSystemError(caught) && caught.code).toBe("SESSION_ERROR");
    expect(isSystemError(caught) && caught.cause).toBe(cause);
  });

  // TC-logout-003 — the point of the translation: `serializeError` falls
  // back to `kind: "unknown"` for anything that is not a
  // `SerializableError`, so a bare throw would never reach the client as
  // a system error (ADR-010).
  it("serializes to kind: system at the transport boundary (TC-logout-003)", () => {
    let caught: unknown;
    try {
      endSession(() => {
        throw new Error("response already committed");
      });
    } catch (error) {
      caught = error;
    }

    expect(serializeError(caught)).toEqual({
      kind: "system",
      code: "SESSION_ERROR",
      message: "Failed to write the session cookie",
      retryable: false,
    });
  });

  it("does not translate a non-throwing sink into an error", () => {
    expect(() => endSession(() => undefined)).not.toThrow();
  });
});
