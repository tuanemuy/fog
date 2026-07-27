import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { content } from "../../../config";
import { FakeLogger } from "../../__tests__/fakes";
import { logout } from "../logout";

// Every dependency a usecase could reach for is a tripwire: logout performs
// no domain operation, no persistence and no event, so touching any of
// these is the failure.
function trippingContainer(): {
  container: RequestContainer;
  touched: string[];
} {
  const touched: string[] = [];
  const trip = (name: string) => {
    touched.push(name);
    throw new Error(`logout must not touch ${name}`);
  };

  return {
    touched,
    container: {
      config: { ...content, appUrl: "http://localhost:3000" },
      identity: {
        registerWithPassword: async () => trip("identity.register"),
        findPasswordCredential: async () => trip("identity.findCredential"),
        getAccountAuthority: async () => trip("identity.getAuthority"),
        getCurrentAccount: async () => trip("identity.getCurrent"),
      },
      passwordHasher: {
        hash: async () => trip("passwordHasher.hash"),
        verify: async () => trip("passwordHasher.verify"),
      },
      sessionCodec: {
        issue: async () => trip("sessionCodec.issue"),
        verify: async () => trip("sessionCodec.verify"),
      },
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: new FakeLogger(),
    },
  };
}

describe("logout", () => {
  it("resolves to void without touching persistence or events (TC-logout-001)", async () => {
    const { container, touched } = trippingContainer();

    await expect(
      logout({
        container,
        input: { userId: "01950000-0000-7000-8000-000000000001" },
      }),
    ).resolves.toBeUndefined();

    expect(touched).toEqual([]);
  });

  // The one piece of work the usecase does: a caller with a broken
  // session should hear about it here rather than downstream.
  it("rejects an empty userId at the value object", async () => {
    const { container } = trippingContainer();

    let caught: unknown;
    await logout({ container, input: { userId: "  " } }).catch((error) => {
      caught = error;
    });

    expect(isBusinessRuleError(caught)).toBe(true);
    expect(isBusinessRuleError(caught) && caught.code).toBe(
      "IDENTITY_INVALID_USER_ID",
    );
  });
});
