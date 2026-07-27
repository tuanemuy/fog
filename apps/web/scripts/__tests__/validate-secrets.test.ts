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

  it("requires the state-only mail encryption secret", () => {
    expect(
      validateSecretInventory({
        required: ["IDENTITY_MAIL_ENCRYPTION_KEY"],
        configured: [],
        forbidden: new Set(["SESSION_SECRET"]),
        allowed: new Set(["IDENTITY_MAIL_ENCRYPTION_KEY"]),
      }),
    ).toEqual(["missing required secret IDENTITY_MAIL_ENCRYPTION_KEY"]);
  });

  it("rejects a retired previous routing secret outside a rotation window", () => {
    expect(
      validateSecretInventory({
        required: [
          "SESSION_SECRET",
          "DIRECTORY_ROUTING_SECRET_ACTIVE",
          "PITR_OPERATOR_TOKEN",
        ],
        configured: [
          { name: "SESSION_SECRET" },
          { name: "DIRECTORY_ROUTING_SECRET_ACTIVE" },
          { name: "DIRECTORY_ROUTING_SECRET_PREVIOUS" },
          { name: "PITR_OPERATOR_TOKEN" },
        ],
        allowed: new Set([
          "SESSION_SECRET",
          "DIRECTORY_ROUTING_SECRET_ACTIVE",
          "PITR_OPERATOR_TOKEN",
        ]),
      }),
    ).toEqual([
      "unexpected secret is present: DIRECTORY_ROUTING_SECRET_PREVIOUS",
    ]);
  });
});
