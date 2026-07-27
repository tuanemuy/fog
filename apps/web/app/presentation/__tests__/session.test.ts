import { installContainerStore } from "@repo/core/application/di/containerStore";
import type { RequestContainer } from "@repo/core/application/di/types";
import { isSystemError } from "@repo/core/application/errors";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { content } from "@repo/core/config";
import { beforeEach, describe, expect, it } from "vitest";
import { serializeError } from "../errorResponse";
import { endSession, startSession } from "../session";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from "../sessionCookie";

const USER_ID = "01950000-0000-7000-8000-000000000001";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const TOKEN = "issued.session.token";

describe("endSession", () => {
  it("writes the expiry cookie through the header sink (TC-logout-002)", () => {
    const written: string[] = [];
    endSession((value) => {
      written.push(value);
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(written[0]).toContain("Max-Age=0");
  });

  it("translates a failing header write into SystemError(SESSION_ERROR) (TC-logout-003)", () => {
    const cause = new Error("response already committed");

    let caught: unknown;
    try {
      endSession(() => {
        throw cause;
      });
    } catch (error) {
      caught = error;
    }

    expect(isSystemError(caught)).toBe(true);
    expect(isSystemError(caught) && caught.code).toBe("SESSION_ERROR");
    expect(isSystemError(caught) && caught.cause).toBe(cause);
  });

  // The point of the translation: `serializeError` falls back to
  // `kind: "unknown"` for anything that is not a `SerializableError`, so a
  // bare throw would never reach the client as a system error.
  it("serializes to kind: system at the transport boundary (TC-logout-003)", () => {
    let caught: unknown;
    try {
      endSession(() => {
        throw new Error("response already committed");
      });
    } catch (error) {
      caught = error;
    }

    expect(serializeError(caught)).toEqual({
      kind: "system",
      code: "SESSION_ERROR",
      message: "Failed to write the session cookie",
      retryable: false,
    });
  });

  it("does not translate a non-throwing sink into an error", () => {
    expect(() => endSession(() => undefined)).not.toThrow();
  });
});

describe("startSession", () => {
  let issued: ReadonlyArray<readonly [string, Date]>;

  beforeEach(() => {
    issued = [];
    const container = {
      config: { ...content, appUrl: "http://localhost:3000" },
      passwordHasher: {
        hash: async () => {
          throw new Error("startSession must not hash");
        },
        verify: async () => {
          throw new Error("startSession must not verify");
        },
      },
      sessionCodec: {
        issue: async (userId: string, now: Date) => {
          issued = [...issued, [userId, now]];
          return TOKEN;
        },
        verify: async () => {
          throw new Error("startSession must not verify a token");
        },
      },
      clock: { now: () => NOW },
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
    } satisfies RequestContainer;

    installContainerStore({ getStore: () => container });
  });

  it("issues exactly one token, stamped with the container clock", async () => {
    await startSession(USER_ID, () => undefined);

    expect(issued).toEqual([[USER_ID, NOW]]);
  });

  it("writes the issued token as the session cookie", async () => {
    const written: string[] = [];

    await startSession(USER_ID, (value) => {
      written.push(value);
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`${SESSION_COOKIE_NAME}=${TOKEN}`);
    // The attributes are what make the cookie a session credential rather
    // than a readable string, and `Max-Age` is what makes it survive the
    // tab being closed.
    expect(written[0]).toContain("Path=/");
    expect(written[0]).toContain("HttpOnly");
    expect(written[0]).toContain("SameSite=Lax");
    expect(written[0]).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
  });

  // Shares `writeSessionCookie` with `endSession`, so this also guards
  // the two staying on one translation.
  it("translates a failing header write into SystemError(SESSION_ERROR)", async () => {
    const cause = new Error("response already committed");

    let caught: unknown;
    try {
      await startSession(USER_ID, () => {
        throw cause;
      });
    } catch (error) {
      caught = error;
    }

    expect(isSystemError(caught)).toBe(true);
    expect(isSystemError(caught) && caught.code).toBe("SESSION_ERROR");
    expect(isSystemError(caught) && caught.cause).toBe(cause);
  });
});
