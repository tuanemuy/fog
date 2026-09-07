import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { EventId } from "../event";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  throw new Error("expected the factory to throw");
}

describe("EventId (DOM-identity-045)", () => {
  it("accepts a minted id unchanged", () => {
    const minted = crypto.randomUUID();
    expect(EventId.create(minted)).toBe(minted);
  });

  it("trims surrounding whitespace, as `UserId` does", () => {
    expect(EventId.create("  01950000-0000-7000-8000-000000000001  ")).toBe(
      "01950000-0000-7000-8000-000000000001",
    );
  });

  it("rejects an empty id with BusinessRuleError", () => {
    expect(codeOf(() => EventId.create(""))).toBe("INVALID_EVENT_ID");
  });

  it("rejects a whitespace-only id with BusinessRuleError", () => {
    expect(codeOf(() => EventId.create("   \t\n "))).toBe("INVALID_EVENT_ID");
  });
});
