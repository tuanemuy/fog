import { ConflictError } from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { CODED_ERROR_BRAND } from "../error";

describe("CODED_ERROR_BRAND", () => {
  it("is present on a CodedError subclass (ApplicationError)", () => {
    const error = new ConflictError("TEST", "test");
    expect(CODED_ERROR_BRAND in error).toBe(true);
  });

  it("is present on a CodedError subclass (BusinessRuleError)", () => {
    const error = new BusinessRuleError("TEST", "test");
    expect(CODED_ERROR_BRAND in error).toBe(true);
  });

  it("is absent on a plain Error", () => {
    expect(CODED_ERROR_BRAND in new Error("plain")).toBe(false);
  });

  it("is absent on a plain object", () => {
    expect(CODED_ERROR_BRAND in {}).toBe(false);
  });
});
