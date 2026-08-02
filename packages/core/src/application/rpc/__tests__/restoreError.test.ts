import {
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isSystemError,
  isUnauthorizedError,
  isValidationError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { RPC_ENVELOPE_VERSION } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import { RESTORABLE_ERROR_KINDS, restoreError, unwrap } from "../restoreError";

function payload(kind: string, code: string | null = "CODE") {
  return { kind, code, message: `${kind} failed` };
}

describe("restoreError", () => {
  it("restores every kind an envelope can carry", () => {
    expect(isBusinessRuleError(restoreError(payload("business")))).toBe(true);
    expect(isNotFoundError(restoreError(payload("notFound")))).toBe(true);
    expect(isConflictError(restoreError(payload("conflict")))).toBe(true);
    expect(isUnauthorizedError(restoreError(payload("unauthorized")))).toBe(
      true,
    );
    expect(isForbiddenError(restoreError(payload("forbidden")))).toBe(true);
    expect(isValidationError(restoreError(payload("validation")))).toBe(true);
    expect(isSystemError(restoreError(payload("system")))).toBe(true);
  });

  it("keeps the code and message", () => {
    const restored = restoreError(payload("conflict", "UNIQUE_VIOLATION"));
    expect(isConflictError(restored) && restored.code).toBe("UNIQUE_VIOLATION");
    expect(restored.message).toBe("conflict failed");
  });

  it("restores a known system code and falls back for an unknown one", () => {
    const known = restoreError(payload("system", "STORAGE_CAPACITY_EXCEEDED"));
    expect(isSystemError(known) && known.code).toBe(
      SystemErrorCode.StorageCapacityExceeded,
    );
    const unknownCode = restoreError(payload("system", "NOT_A_REAL_CODE"));
    expect(isSystemError(unknownCode) && unknownCode.code).toBe(
      SystemErrorCode.DatabaseError,
    );
  });

  it("turns an unknown kind into SystemError(DataIntegrityError)", () => {
    // Adding a serialized variant and forgetting the table must be loud, not
    // silently collapsed.
    const restored = restoreError(payload("brandNew"));
    expect(isSystemError(restored) && restored.code).toBe(
      SystemErrorCode.DataIntegrityError,
    );
    expect(restored.message).toContain("brandNew");
  });

  it("lists exactly the seven core-owned kinds", () => {
    expect([...RESTORABLE_ERROR_KINDS].sort()).toEqual([
      "business",
      "conflict",
      "forbidden",
      "notFound",
      "system",
      "unauthorized",
      "validation",
    ]);
  });
});

describe("unwrap", () => {
  it("returns the value on the ok branch", () => {
    expect(unwrap({ v: RPC_ENVELOPE_VERSION, ok: true, value: 7 })).toBe(7);
  });

  it("throws the restored error on the failure branch", () => {
    expect(() =>
      unwrap({
        v: RPC_ENVELOPE_VERSION,
        ok: false,
        error: payload("notFound", "USER_NOT_FOUND"),
      }),
    ).toThrow("notFound failed");
  });
});
