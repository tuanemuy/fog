import {
  ConflictError,
  ForbiddenError,
  isApplicationError,
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isSystemError,
  isUnauthorizedError,
  isValidationError,
  NotFoundError,
  SystemError,
  SystemErrorCode,
  UnauthorizedError,
  ValidationError,
} from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";

describe("isApplicationError", () => {
  it("returns true for a ConflictError", () => {
    expect(isApplicationError(new ConflictError("TEST", "test"))).toBe(true);
  });

  it("returns true for a BusinessRuleError (both extend CodedError)", () => {
    expect(isApplicationError(new BusinessRuleError("TEST", "test"))).toBe(
      true,
    );
  });

  it("returns false for null", () => {
    expect(isApplicationError(null)).toBe(false);
  });

  it("returns false for a plain object", () => {
    expect(isApplicationError({})).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isApplicationError(new Error("plain"))).toBe(false);
  });
});

describe("isConflictError", () => {
  it("returns true for a ConflictError", () => {
    expect(isConflictError(new ConflictError("TEST", "test"))).toBe(true);
  });

  it("returns false for a NotFoundError", () => {
    expect(isConflictError(new NotFoundError("TEST", "test"))).toBe(false);
  });

  it("returns false for a BusinessRuleError", () => {
    expect(isConflictError(new BusinessRuleError("TEST", "test"))).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isConflictError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isConflictError(null)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isConflictError(new Error("plain"))).toBe(false);
  });
});

describe("isNotFoundError", () => {
  it("returns true for a NotFoundError", () => {
    expect(isNotFoundError(new NotFoundError("TEST", "test"))).toBe(true);
  });

  it("returns false for an empty object", () => {
    expect(isNotFoundError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isNotFoundError(null)).toBe(false);
  });
});

describe("isValidationError", () => {
  it("returns true for a ValidationError", () => {
    expect(isValidationError(new ValidationError("TEST", "test"))).toBe(true);
  });

  it("returns false for an empty object", () => {
    expect(isValidationError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isValidationError(null)).toBe(false);
  });
});

describe("isUnauthorizedError", () => {
  it("returns true for an UnauthorizedError", () => {
    expect(isUnauthorizedError(new UnauthorizedError("TEST", "test"))).toBe(
      true,
    );
  });

  it("returns false for an empty object", () => {
    expect(isUnauthorizedError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isUnauthorizedError(null)).toBe(false);
  });
});

describe("isForbiddenError", () => {
  it("returns true for a ForbiddenError", () => {
    expect(isForbiddenError(new ForbiddenError("TEST", "test"))).toBe(true);
  });

  it("returns false for an empty object", () => {
    expect(isForbiddenError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isForbiddenError(null)).toBe(false);
  });
});

describe("isSystemError", () => {
  it("returns true for a SystemError", () => {
    expect(
      isSystemError(new SystemError(SystemErrorCode.DatabaseError, "test")),
    ).toBe(true);
  });

  it("returns false for an empty object", () => {
    expect(isSystemError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSystemError(null)).toBe(false);
  });
});
