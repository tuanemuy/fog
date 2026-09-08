import {
  FakeTokenGenerator,
  trippingIdentityGateway,
} from "@repo/core/application/__tests__/fakes";
import { trippingExportGateway } from "@repo/core/application/__tests__/fakes/fakeExportGateway";
import { trippingKnowledgeGateway } from "@repo/core/application/__tests__/fakes/fakeKnowledgeGateway";
import { trippingMemoGateway } from "@repo/core/application/__tests__/fakes/fakeMemoGateway";
import { trippingSearchGateway } from "@repo/core/application/__tests__/fakes/fakeSearchGateway";
import { trippingTrashGateway } from "@repo/core/application/__tests__/fakes/fakeTrashGateway";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  isSystemError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type { IdentityGateway } from "@repo/core/application/identity/gateway";
import { createIdentityTuning } from "@repo/core/application/identity/tuning";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUserId } from "../currentUser";

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
}));

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => mocks.cookie,
  getRequestUrl: () => new URL("https://app.example/"),
  setResponseHeader: () => undefined,
}));

const USER_ID = "01950000-0000-7000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const TOKEN = "issued.session.token";
const SESSION_EPOCH = 4;

function installContainer(
  readAccountState: IdentityGateway["readAccountState"],
): void {
  const container = {
    config: { ...content, appUrl: "http://localhost:3000", ssoProviders: [] },
    identityGateway: trippingIdentityGateway(
      (name) => {
        throw new Error(`getCurrentUserId must not reach ${name}`);
      },
      { readAccountState },
    ),
    identityTuning: createIdentityTuning(),
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`the presentation layer must not touch ${name}`);
    }),
    knowledgeGateway: trippingKnowledgeGateway((name) => {
      throw new Error(`the presentation layer must not touch ${name}`);
    }),
    searchGateway: trippingSearchGateway((name) => {
      throw new Error(`the presentation layer must not touch ${name}`);
    }),
    trashGateway: trippingTrashGateway((name) => {
      throw new Error(`the presentation layer must not touch ${name}`);
    }),
    exportGateway: trippingExportGateway((name) => {
      throw new Error(`the presentation layer must not touch ${name}`);
    }),
    passwordHasher: {
      hash: async () => {
        throw new Error("getCurrentUserId must not hash");
      },
      verify: async () => {
        throw new Error("getCurrentUserId must not verify");
      },
    },
    sessionCodec: {
      issue: async () => {
        throw new Error("getCurrentUserId must not issue a token");
      },
      verify: async (token: string) =>
        token === TOKEN
          ? { userId: USER_ID, sessionEpoch: SESSION_EPOCH }
          : null,
    },
    clock: { now: () => NOW },
    idGenerator: UuidV7Generator,
    tokenGenerator: new FakeTokenGenerator(),
    logger: ConsoleLogger,
  } satisfies RequestContainer;

  installContainerStore({ getStore: () => container });
}

describe("getCurrentUserId", () => {
  beforeEach(() => {
    mocks.cookie = TOKEN;
  });

  it("answers the token's user for an active account on the same generation", async () => {
    installContainer(async () => ({
      status: "active",
      sessionEpoch: SESSION_EPOCH,
      resetVersion: 0,
    }));
    expect(await getCurrentUserId()).toBe(USER_ID);
  });

  it("is nobody without a cookie, without reading the account", async () => {
    mocks.cookie = undefined;
    installContainer(async () => {
      throw new Error("must not read the account without a token");
    });
    expect(await getCurrentUserId()).toBeNull();
  });

  it("is nobody when the account has moved past the token's generation", async () => {
    installContainer(async () => ({
      status: "active",
      sessionEpoch: SESSION_EPOCH + 1,
      resetVersion: 0,
    }));
    expect(await getCurrentUserId()).toBeNull();
  });

  it("is nobody when the initialised object holds no account row", async () => {
    installContainer(async () => null);
    expect(await getCurrentUserId()).toBeNull();
  });

  // The fold lives here and nowhere else: the gateway passes
  // `SystemError(NotInitialized)` through unchanged, and a token naming an
  // object that was never initialised is a stale or forged credential.
  it("folds a never-initialised object into nobody", async () => {
    installContainer(async () => {
      throw new SystemError(
        SystemErrorCode.NotInitialized,
        "The Durable Object has not been initialised",
      );
    });
    expect(await getCurrentUserId()).toBeNull();
  });

  it("lets every other system error through", async () => {
    const cause = new SystemError(
      SystemErrorCode.DatabaseError,
      "storage threw",
    );
    installContainer(async () => {
      throw cause;
    });
    await expect(getCurrentUserId()).rejects.toSatisfy(
      (error) =>
        isSystemError(error) && error.code === SystemErrorCode.DatabaseError,
    );
  });
});
