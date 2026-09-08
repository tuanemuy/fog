import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import {
  crownedToken,
  forwardTokenFor,
  forwardTokenOf,
  operationIdOf,
  parseTerminalReason,
  TERMINAL_REASON_TOKENS,
  terminalReason,
} from "../terminalReason";

describe("terminal_reason", () => {
  it("is one of six tokens, with the saga's operationId after one space", () => {
    expect(TERMINAL_REASON_TOKENS).toHaveLength(6);
    expect(terminalReason("forward-conflict", "op-1")).toBe(
      "forward-conflict op-1",
    );
    expect(terminalReason("forward-exhausted", null)).toBe("forward-exhausted");
    expect(
      parseTerminalReason("cleanup-material-lost:forward-conflict op-1"),
    ).toEqual({
      token: "cleanup-material-lost:forward-conflict",
      operationId: "op-1",
    });
    expect(parseTerminalReason("forward-exhausted")).toEqual({
      token: "forward-exhausted",
      operationId: null,
    });
    expect(parseTerminalReason("DATABASE_ERROR")).toBeNull();
    expect(parseTerminalReason(null)).toBeNull();
  });

  // RC-9: a crown goes on the forward token, never on the current value,
  // so re-terminating a crowned row keeps the vocabulary at six.
  it("crowns the forward reason, whatever the current value carries", () => {
    for (const current of [
      "forward-conflict op",
      "cleanup-exhausted:forward-conflict op",
      "cleanup-material-lost:forward-conflict op",
    ]) {
      expect(crownedToken("cleanup-exhausted", forwardTokenOf(current))).toBe(
        "cleanup-exhausted:forward-conflict",
      );
    }
    expect(forwardTokenOf("cleanup-material-lost:forward-exhausted")).toBe(
      "forward-exhausted",
    );
    expect(forwardTokenOf(null)).toBe("forward-exhausted");
    expect(forwardTokenOf("NOT_A_TOKEN")).toBe("forward-exhausted");
    for (const ending of [
      "cleanup-exhausted",
      "cleanup-material-lost",
    ] as const) {
      for (const forward of [
        "forward-conflict",
        "forward-exhausted",
      ] as const) {
        expect(TERMINAL_REASON_TOKENS).toContain(crownedToken(ending, forward));
      }
    }
  });

  it("a ConflictError is forward-conflict; anything else is exhaustion", () => {
    expect(
      forwardTokenFor(new ConflictError("OPTIMISTIC_LOCK_FAILURE", "x")),
    ).toBe("forward-conflict");
    expect(
      forwardTokenFor(new SystemError(SystemErrorCode.DatabaseError, "x")),
    ).toBe("forward-exhausted");
    expect(forwardTokenFor(new Error("x"))).toBe("forward-exhausted");
  });

  it("reads the operationId off a saga payload only", () => {
    expect(operationIdOf({ operationId: "op-1", locator: {} })).toBe("op-1");
    expect(operationIdOf({})).toBeNull();
    expect(operationIdOf({ operationId: "" })).toBeNull();
    expect(operationIdOf(null)).toBeNull();
  });
});
