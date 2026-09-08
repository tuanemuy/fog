import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { type FailureFacts, failureOutcome } from "../jobRunner";

const conflict = new ConflictError("EMAIL_ALREADY_REGISTERED", "held");
const failure = new SystemError(SystemErrorCode.DatabaseError, "boom");

function facts(overrides: Partial<FailureFacts>): FailureFacts {
  return {
    error: failure,
    attempt: 0,
    maxAttempts: 5,
    currentReason: null,
    stageRan: false,
    hasStage: () => false,
    operationId: "op-1",
    ...overrides,
  };
}

// The seven triggers of `spec/recovery/index.md` 終端モードの各契機, as
// the runner decides them; the integration suites hold the columns each
// one writes.
describe("failureOutcome", () => {
  it("a forward failure under the ceiling backs off", () => {
    expect(failureOutcome(facts({ attempt: 2 }))).toEqual({
      kind: "backoff",
      attempt: 3,
    });
  });

  it("a ConflictError confirms non-progress on the wake-up it happens", () => {
    expect(
      failureOutcome(
        facts({ error: conflict, attempt: 0, hasStage: () => true }),
      ),
    ).toEqual({ kind: "enter-terminal", reason: "forward-conflict op-1" });
    expect(failureOutcome(facts({ error: conflict, attempt: 0 }))).toEqual({
      kind: "poison",
      reason: "forward-conflict op-1",
    });
  });

  it("the ceiling confirms; a stage means terminal mode, none means poison", () => {
    expect(failureOutcome(facts({ attempt: 4, hasStage: () => true }))).toEqual(
      { kind: "enter-terminal", reason: "forward-exhausted op-1" },
    );
    expect(failureOutcome(facts({ attempt: 4, operationId: null }))).toEqual({
      kind: "poison",
      reason: "forward-exhausted",
    });
  });

  it("a row in terminal mode whose stage is gone re-confirms with the current reason, never re-enters", () => {
    expect(
      failureOutcome(
        facts({
          error: conflict,
          currentReason: "forward-exhausted op-1",
          hasStage: () => true,
        }),
      ),
    ).toEqual({ kind: "poison", reason: "forward-conflict op-1" });
  });

  it("a cleanup failure backs off under the ceiling and burns out with a crown at it, keeping the forward reason", () => {
    expect(
      failureOutcome(
        facts({
          stageRan: true,
          attempt: 1,
          currentReason: "forward-conflict op-1",
        }),
      ),
    ).toEqual({ kind: "backoff", attempt: 2 });
    // A ConflictError out of a cleanup RPC is just a failure.
    expect(
      failureOutcome(
        facts({
          stageRan: true,
          error: conflict,
          attempt: 0,
          currentReason: "forward-conflict op-1",
        }),
      ),
    ).toEqual({ kind: "backoff", attempt: 1 });
    expect(
      failureOutcome(
        facts({
          stageRan: true,
          attempt: 4,
          currentReason: "forward-conflict op-1",
        }),
      ),
    ).toEqual({
      kind: "poison",
      reason: "cleanup-exhausted:forward-conflict op-1",
    });
    // Re-crowning a crowned value stays within the six.
    expect(
      failureOutcome(
        facts({
          stageRan: true,
          attempt: 4,
          currentReason: "cleanup-material-lost:forward-exhausted op-1",
        }),
      ),
    ).toEqual({
      kind: "poison",
      reason: "cleanup-exhausted:forward-exhausted op-1",
    });
  });
});
