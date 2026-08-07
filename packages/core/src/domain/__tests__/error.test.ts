import {
  BusinessRuleError,
  isBusinessRuleError,
  isRehydrationError,
  RehydrationError,
} from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";

describe("isBusinessRuleError", () => {
  it("returns true for a BusinessRuleError", () => {
    expect(isBusinessRuleError(new BusinessRuleError("TEST", "test"))).toBe(
      true,
    );
  });

  it("returns false for an empty object", () => {
    expect(isBusinessRuleError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isBusinessRuleError(null)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isBusinessRuleError(new Error("plain"))).toBe(false);
  });
});

describe("isRehydrationError", () => {
  it("returns true for a RehydrationError", () => {
    expect(isRehydrationError(new RehydrationError("test"))).toBe(true);
  });

  it("returns false for a BusinessRuleError", () => {
    expect(isRehydrationError(new BusinessRuleError("TEST", "test"))).toBe(
      false,
    );
  });

  it("returns false for an empty object", () => {
    expect(isRehydrationError({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRehydrationError(null)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isRehydrationError(new Error("plain"))).toBe(false);
  });
});
