import { ConflictError } from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "@repo/core/domain/identity/errorCode";
import { RPC_ENVELOPE_VERSION } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import { err, ok } from "../platform/envelope";

describe("rpc envelope", () => {
  it("stamps the envelope version on both branches", () => {
    expect(ok(1).v).toBe(RPC_ENVELOPE_VERSION);
    expect(err(new Error("boom")).v).toBe(RPC_ENVELOPE_VERSION);
  });

  it("carries the value verbatim on success", () => {
    const envelope = ok({ userId: "u1", epoch: 3 });
    expect(envelope).toEqual({
      v: RPC_ENVELOPE_VERSION,
      ok: true,
      value: { userId: "u1", epoch: 3 },
    });
  });

  it("serializes structurally, without enumerating concrete classes", () => {
    const envelope = err(
      new ConflictError("OPTIMISTIC_LOCK_FAILURE", "Optimistic lock failure"),
    );
    expect(envelope.ok).toBe(false);
    expect(!envelope.ok && envelope.error).toEqual({
      kind: "conflict",
      code: "OPTIMISTIC_LOCK_FAILURE",
      message: "Optimistic lock failure",
      retryable: false,
    });
  });

  it("serializes domain errors through the same path", () => {
    const envelope = err(
      new BusinessRuleError<string>(
        IdentityErrorCode.LastCredentialRemoval,
        "cannot remove",
      ),
    );
    expect(!envelope.ok && envelope.error.kind).toBe("business");
  });

  it("falls back to `system`, never presentation's `unknown`", () => {
    for (const input of [new Error("raw"), "raw string", 42]) {
      const envelope = err(input);
      expect(!envelope.ok && envelope.error.kind).toBe("system");
    }
  });
});
