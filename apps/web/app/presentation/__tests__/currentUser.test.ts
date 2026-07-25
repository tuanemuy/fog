import { installContainerStore } from "@repo/core/application/di/containerStore";
import type { RequestContainer } from "@repo/core/application/di/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "../sessionCookie";

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  requestUrl: new URL("https://app.example/settings"),
  headers: [] as Array<readonly [string, string]>,
}));

// The factory body runs when `../currentUser` is first imported, which
// every test does lazily — so the constant is initialised by then and the
// mock cannot drift from the name the session writer actually uses.
vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (name: string) =>
    name === SESSION_COOKIE_NAME ? mocks.cookie : undefined,
  getRequestUrl: () => mocks.requestUrl,
  setResponseHeader: (name: string, value: string) => {
    mocks.headers.push([name, value] as const);
  },
}));

const USER_ID = "01950000-0000-7000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const TOKEN = "payload.signature";

type Verified = { userId: string } | null;

let verifyCalls: ReadonlyArray<readonly [string, Date]>;

function installContainer(verified: Verified): void {
  verifyCalls = [];
  const container = {
    config: { ...content, appUrl: "https://app.example" },
    unitOfWorkProvider: {
      run: async () => {
        throw new Error("reading the session must not open a unit of work");
      },
    },
    passwordHasher: {
      hash: async () => {
        throw new Error("reading the session must not hash");
      },
      verify: async () => {
        throw new Error("reading the session must not verify a password");
      },
    },
    sessionCodec: {
      issue: async () => {
        throw new Error("reading the session must not issue a token");
      },
      verify: async (token: string, now: Date) => {
        verifyCalls = [...verifyCalls, [token, now]];
        return verified;
      },
    },
    clock: { now: () => NOW },
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  } satisfies RequestContainer;

  installContainerStore({ getStore: () => container });
}

async function currentUser() {
  return await import("../currentUser");
}

async function captureRedirect(): Promise<unknown> {
  const { requireUserId } = await currentUser();
  try {
    await requireUserId();
  } catch (error) {
    return error;
  }
  throw new Error("expected requireUserId to redirect");
}

beforeEach(() => {
  mocks.cookie = undefined;
  mocks.requestUrl = new URL("https://app.example/settings");
  mocks.headers = [];
});

describe("getCurrentUserId", () => {
  it("reads the session cookie and hands the token to the codec with the container clock", async () => {
    mocks.cookie = TOKEN;
    installContainer({ userId: USER_ID });

    const { getCurrentUserId } = await currentUser();
    await expect(getCurrentUserId()).resolves.toBe(USER_ID);
    expect(verifyCalls).toEqual([[TOKEN, NOW]]);
  });

  it("reports nobody when the request carries no session cookie", async () => {
    installContainer({ userId: USER_ID });

    const { getCurrentUserId } = await currentUser();
    await expect(getCurrentUserId()).resolves.toBeNull();
    // Not merely "returns null": a codec consulted without a token would
    // mean the cookie read is decorative.
    expect(verifyCalls).toEqual([]);
  });

  // A tampered or expired token is exactly a token the codec refuses, and
  // `verified?.userId ?? null` is the only thing standing between that
  // refusal and a signed-in session. Written as `verified.userId` it
  // would still typecheck against a codec that never returns null.
  it("reports nobody when the codec refuses the token", async () => {
    mocks.cookie = "tampered.token";
    installContainer(null);

    const { getCurrentUserId } = await currentUser();
    await expect(getCurrentUserId()).resolves.toBeNull();
    expect(verifyCalls).toEqual([["tampered.token", NOW]]);
  });
});

describe("requireUserId", () => {
  // AC-15 / manual TC-23. The guard is the authoritative "this response
  // carries protected data" point (.issue/1/adr.md ADR-031), so the header
  // that keeps a logged-out back button from restoring a protected screen
  // is emitted here and nowhere else. Router-level invalidation cannot
  // reach the
  // browser's history / heuristic caches; only this header can.
  it("marks an authenticated response as uncacheable", async () => {
    mocks.cookie = TOKEN;
    installContainer({ userId: USER_ID });

    const { requireUserId } = await currentUser();
    await expect(requireUserId()).resolves.toBe(USER_ID);

    expect(mocks.headers).toEqual([["cache-control", "no-store, private"]]);
  });

  it("sends a refused token back to the login screen rather than through", async () => {
    mocks.cookie = "expired.token";
    installContainer(null);

    const caught = await captureRedirect();

    expect(isRedirect(caught)).toBe(true);
    expect(isRedirect(caught) && caught.options.to).toBe("/login");
    expect(isRedirect(caught) && caught.options.search).toEqual({
      redirect: "/settings",
    });
  });
});
