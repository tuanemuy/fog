import {
  credentialLocators,
  MIN_DIRECTORY_ROUTING_SECRET_BYTES,
  validateDirectoryKeyring,
} from "@repo/core/adapters/cloudflare/identityRouting";
import { describe, expect, it } from "vitest";

const secret = (character: string) =>
  character.repeat(MIN_DIRECTORY_ROUTING_SECRET_BYTES);

describe("directory routing keyring validation", () => {
  it("rejects weak, duplicate, and same-generation keys", () => {
    expect(() =>
      validateDirectoryKeyring({
        active: { generation: "v2", secret: "weak" },
      }),
    ).toThrow(/at least/);
    expect(() =>
      validateDirectoryKeyring({
        active: { generation: "v2", secret: secret("a") },
        previous: { generation: "v2", secret: secret("b") },
      }),
    ).toThrow(/generations/);
    expect(() =>
      validateDirectoryKeyring({
        active: { generation: "v2", secret: secret("a") },
        previous: { generation: "v1", secret: secret("a") },
      }),
    ).toThrow(/secrets/);
  });

  it("always computes both generations in stable order", async () => {
    const locators = await credentialLocators("email:person@example.com", {
      active: { generation: "v2", secret: secret("a") },
      previous: { generation: "v1", secret: secret("b") },
    });
    expect(locators).toHaveLength(2);
    expect(new Set(locators.map((item) => item.generation))).toEqual(
      new Set(["v1", "v2"]),
    );
  });
});
