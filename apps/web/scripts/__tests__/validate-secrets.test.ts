import { describe, expect, it } from "vitest";
import { validateSecretInventory } from "../validate-secrets";

describe("validateSecretInventory", () => {
  it("reports missing required names without reading values", () => {
    expect(
      validateSecretInventory({
        required: ["SESSION_SECRET", "DIRECTORY_ROUTING_SECRET_ACTIVE"],
        configured: [{ name: "SESSION_SECRET" }],
      }),
    ).toEqual(["missing required secret DIRECTORY_ROUTING_SECRET_ACTIVE"]);
  });

  it("rejects request-only secrets on the state Worker", () => {
    expect(
      validateSecretInventory({
        required: [],
        configured: [{ name: "SESSION_SECRET" }],
        forbidden: new Set(["SESSION_SECRET"]),
      }),
    ).toEqual(["forbidden request-only secret is present: SESSION_SECRET"]);
  });
});
