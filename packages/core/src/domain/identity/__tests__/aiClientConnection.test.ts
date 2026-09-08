import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { AiClientConnection } from "../entity";
import { TokenScope, UserId } from "../valueObject";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const LATER = new Date("2026-09-08T01:00:00.000Z");

function create(name = "Claude Desktop") {
  return AiClientConnection.create(
    {
      id: "conn-1",
      userId: UserId.create("user-1"),
      clientName: name,
      createdAtResetVersion: 3,
    },
    NOW,
  );
}

describe("AiClientConnection", () => {
  it("is born active, unused, at version 0, carrying the reset version it was born under", () => {
    const connection = create("  Claude Desktop  ");
    expect(connection).toMatchObject({
      status: "active",
      clientName: "Claude Desktop",
      lastUsedAt: null,
      version: 0,
      createdAtResetVersion: 3,
      connectedAt: NOW,
    });
  });

  it("refuses a blank or over-long client name", () => {
    for (const name of ["", "   ", "x".repeat(101)]) {
      let caught: unknown = null;
      try {
        create(name);
      } catch (error) {
        caught = error;
      }
      expect(isBusinessRuleError(caught)).toBe(true);
    }
    expect(create("x".repeat(100)).clientName).toHaveLength(100);
  });

  it("revokes irreversibly, stamping the time and moving the version", () => {
    const revoked = AiClientConnection.revoke(create(), LATER);
    expect(revoked).toMatchObject({
      status: "revoked",
      revokedAt: LATER,
      version: 1,
      updatedAt: LATER,
    });
    // The type admits no revoke of a revoked one; the value keeps its stamp.
    expect(revoked.createdAtResetVersion).toBe(3);
  });

  it("recordUsage only moves lastUsedAt forward and leaves the version alone", () => {
    const used = AiClientConnection.recordUsage(create(), LATER);
    expect(used.lastUsedAt).toEqual(LATER);
    expect(used.version).toBe(0);
    const earlier = AiClientConnection.recordUsage(used, NOW);
    expect(earlier.lastUsedAt).toEqual(LATER);
  });

  it("the ai scope never allows what the AI faces are not wired to", () => {
    const ai = TokenScope.ai();
    expect(TokenScope.allows(ai, "read")).toBe(true);
    expect(TokenScope.allows(ai, "write")).toBe(true);
    for (const forbidden of ["hardDelete", "trash", "history"] as const) {
      expect(TokenScope.allows(ai, forbidden)).toBe(false);
      expect(TokenScope.allows(TokenScope.human(), forbidden)).toBe(true);
    }
  });
});
