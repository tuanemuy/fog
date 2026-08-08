import { FakeLogger } from "@repo/core/application/__tests__/fakes";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  ConflictError,
  type SerializedConflictError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { content } from "@repo/core/config";
import { CodedError } from "@repo/core/lib/error";
import {
  isNotFound,
  isRedirect,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppServerError,
  extractSerializedError,
  isAppServerError,
  type SerializedError,
  serializeError,
} from "../errorResponse";
import {
  errorResponseMiddleware,
  guardStreamedRender,
} from "../errorResponseMiddleware";

const mocks = vi.hoisted(() => ({ statuses: [] as number[] }));

vi.mock("@tanstack/react-start/server", () => ({
  setResponseStatus: (status: number) => {
    mocks.statuses.push(status);
  },
}));

const INTERNAL_DETAIL =
  "D1_ERROR: no such table: users (/var/task/packages/core/adapters/d1/userRepository.js:120)";

const LOGIN_FAILURE_MESSAGE = "Invalid email or password";

function invalidCredentials(): ValidationError {
  return new ValidationError("INVALID_CREDENTIALS", LOGIN_FAILURE_MESSAGE, {
    email: [LOGIN_FAILURE_MESSAGE],
  });
}

let logger: FakeLogger;

function trip(what: string): never {
  throw new Error(`the error boundary must not ${what}`);
}

function installContainer(): void {
  logger = new FakeLogger();
  const container = {
    config: { ...content, appUrl: "https://app.example" },
    unitOfWorkProvider: { run: async () => trip("open a unit of work") },
    passwordHasher: {
      hash: async () => trip("hash a password"),
      verify: async () => trip("verify a password"),
    },
    sessionCodec: {
      issue: async () => trip("issue a session token"),
      verify: async () => trip("verify a session token"),
    },
    clock: { now: () => new Date(0) },
    idGenerator: UuidV7Generator,
    logger,
  } satisfies RequestContainer;

  installContainerStore({ getStore: () => container });
}

async function run(handler: () => Promise<unknown>): Promise<unknown> {
  return await errorResponseMiddleware.options.server?.({
    next: handler,
  } as never);
}

async function captureFrom(
  boundary: (handler: () => Promise<unknown>) => Promise<unknown>,
  thrown: unknown,
): Promise<unknown> {
  try {
    await boundary(async () => {
      throw thrown;
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the boundary to rethrow");
}

function serializedOf(caught: unknown): SerializedError {
  expect(isAppServerError(caught)).toBe(true);
  return extractSerializedError(caught);
}

// The three hostile shapes a third-party `toSerialized` can take —
// `isSerializableError` proves callability only. Each constructor message is
// the internal detail, so the assertions can tell the raw logged form from the
// redacted client-facing one.
class ThrowingSerializerError extends CodedError {
  override readonly name = "ThrowingSerializerError";
  readonly serializedKind: SerializedConflictError["kind"] = "conflict";

  override toSerialized(): SerializedConflictError {
    throw new Error("serializer exploded");
  }
}

class NullSerializerError extends CodedError {
  override readonly name = "NullSerializerError";
  readonly serializedKind: SerializedConflictError["kind"] = "conflict";

  override toSerialized(): SerializedConflictError {
    return null as unknown as SerializedConflictError;
  }
}

class ThrowingGetterError extends CodedError {
  override readonly name = "ThrowingGetterError";
  readonly serializedKind: SerializedConflictError["kind"] = "conflict";

  override toSerialized(): SerializedConflictError {
    return {
      kind: "conflict",
      get code(): string {
        throw new Error("getter exploded");
      },
      message: this.message,
      retryable: false,
    };
  }
}

const HOSTILE_SERIALIZERS = [
  {
    shape: "throws",
    build: () => new ThrowingSerializerError("X", INTERNAL_DETAIL),
  },
  {
    shape: "answers a non-object",
    build: () => new NullSerializerError("X", INTERNAL_DETAIL),
  },
  {
    shape: "answers a payload whose getter throws",
    build: () => new ThrowingGetterError("X", INTERNAL_DETAIL),
  },
] as const;

beforeEach(() => {
  mocks.statuses = [];
  installContainer();
});

describe("errorResponseMiddleware", () => {
  it("returns the handler result and touches nothing on the happy path", async () => {
    await expect(run(async () => "handler result")).resolves.toBe(
      "handler result",
    );

    expect(mocks.statuses).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  // Control-flow throws must survive by identity: wrapping the redirect the
  // auth guard throws would turn "send this visitor to /login" into a 500.
  it("rethrows a redirect unwrapped", async () => {
    const thrown = redirect({
      to: "/login",
      search: { redirect: "/settings" },
    });

    const caught = await captureFrom(run, thrown);

    expect(caught).toBe(thrown);
    expect(isRedirect(caught)).toBe(true);
    expect(isAppServerError(caught)).toBe(false);
    expect(mocks.statuses).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  it("rethrows a notFound unwrapped", async () => {
    const thrown = notFound();

    const caught = await captureFrom(run, thrown);

    expect(caught).toBe(thrown);
    expect(isNotFound(caught)).toBe(true);
    expect(mocks.statuses).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  // Pins the invariant the middleware's comment names: `isNotFound` is the
  // structural match `obj?.isNotFound === true`, so any value carrying that
  // shape — sentinel or not — skips classification entirely, by identity,
  // with no status set and nothing logged. This is why a thrown value's shape
  // must never derive from external input; if `isNotFound` stops being
  // structural (or the rethrow is removed), this test says so.
  it("passes any value shaped like the notFound sentinel through by identity", async () => {
    const shaped = { isNotFound: true };

    expect(isNotFound(shaped)).toBe(true);

    const caught = await captureFrom(run, shaped);

    expect(caught).toBe(shaped);
    expect(isAppServerError(caught)).toBe(false);
    expect(mocks.statuses).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  // The login form reads its wording off `code`, so the
  // boundary has to carry the usecase's code and field errors through
  // untouched — and must not treat an expected credential failure as an
  // operational incident.
  it("carries a validation failure to the client with its code intact", async () => {
    const caught = await captureFrom(run, invalidCredentials());

    expect(serializedOf(caught)).toEqual({
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: LOGIN_FAILURE_MESSAGE,
      retryable: false,
      fieldErrors: { email: [LOGIN_FAILURE_MESSAGE] },
    });
    expect(mocks.statuses).toEqual([422]);
    expect(logger.entries).toEqual([]);
  });

  it("redacts a system failure for the client but logs it raw", async () => {
    const thrown = new SystemError(
      SystemErrorCode.DatabaseError,
      INTERNAL_DETAIL,
    );

    const caught = await captureFrom(run, thrown);

    expect(serializedOf(caught)).toEqual({
      kind: "system",
      code: null,
      message: "System error",
      retryable: false,
    });
    expect(JSON.stringify(serializedOf(caught))).not.toContain("no such table");
    expect(mocks.statuses).toEqual([500]);

    expect(logger.byLevel("error")).toEqual([
      {
        level: "error",
        message: "Server function failed",
        meta: {
          kind: "system",
          code: SystemErrorCode.DatabaseError,
          message: INTERNAL_DETAIL,
          cause: thrown,
        },
      },
    ]);
  });

  it("redacts an error that reached the boundary unclassified", async () => {
    const caught = await captureFrom(run, new Error(INTERNAL_DETAIL));

    expect(serializedOf(caught)).toEqual({
      kind: "unknown",
      code: null,
      message: "System error",
    });
    expect(mocks.statuses).toEqual([500]);
    expect(logger.byLevel("error")[0]?.meta).toMatchObject({
      kind: "unknown",
      message: INTERNAL_DETAIL,
    });
  });

  // A leaf that already wrapped its own failure (`guardStreamedRender`, a
  // nested server fn) must not be able to smuggle a raw payload past the
  // response boundary.
  it("redacts an AppServerError that still carries a raw payload", async () => {
    const caught = await captureFrom(
      run,
      new AppServerError({
        kind: "system",
        code: SystemErrorCode.DatabaseError,
        message: INTERNAL_DETAIL,
        retryable: false,
      }),
    );

    expect(serializedOf(caught)).toEqual({
      kind: "system",
      code: null,
      message: "System error",
      retryable: false,
    });
    expect(mocks.statuses).toEqual([500]);
  });

  // The boundary catch itself must not throw: a secondary throw from
  // classification would leave the middleware's `catch` and skip status,
  // redaction and logging. `serializeError` fails closed on these, and this
  // pins the whole path: 500, redacted client payload, raw detail logged.
  it.each(HOSTILE_SERIALIZERS)(
    "fails closed to a redacted 500 when toSerialized $shape",
    async ({ build }) => {
      const caught = await captureFrom(run, build());

      expect(serializedOf(caught)).toEqual({
        kind: "unknown",
        code: null,
        message: "System error",
      });
      expect(mocks.statuses).toEqual([500]);
      expect(logger.byLevel("error")[0]?.meta).toMatchObject({
        kind: "unknown",
        message: INTERNAL_DETAIL,
      });
    },
  );

  // `extractSerializedError`'s remnant stage runs the caught value's own
  // getters, so classification itself can throw — the one path
  // `serializeError`'s guard does not cover (its JSDoc names the limit).
  // `toClientError`'s last-resort catch is what keeps it inside the boundary:
  // pre-redacted unknown, 500, and the original value still logged as `cause`.
  it("fails closed to a redacted 500 when the remnant's serialized accessor throws", async () => {
    const hostile = {
      get serialized(): unknown {
        throw new Error("accessor exploded");
      },
    };

    const caught = await captureFrom(run, hostile);

    expect(serializedOf(caught)).toEqual({
      kind: "unknown",
      code: null,
      message: "System error",
    });
    expect(mocks.statuses).toEqual([500]);
    // `cause` is compared by identity: a `toMatchObject` containing the
    // hostile value would run its throwing getter inside the matcher.
    const meta = logger.byLevel("error")[0]?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ kind: "unknown", message: "System error" });
    expect(meta.cause).toBe(hostile);
  });

  it("still answers when the logger itself is unreachable", async () => {
    installContainerStore({ getStore: () => undefined });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const caught = await captureFrom(
        run,
        new SystemError(SystemErrorCode.DatabaseError, INTERNAL_DETAIL),
      );

      expect(serializedOf(caught)).toMatchObject({
        kind: "system",
        code: null,
        message: "System error",
      });
      expect(mocks.statuses).toEqual([500]);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});

// A streaming RSC leaf renders after the handler
// returned, so its throws never reach the middleware above. This is the leaf's
// only redaction and logging point, and forgetting the call is invisible to the
// compiler — which is exactly why the contract is pinned here.
describe("guardStreamedRender", () => {
  it("returns what the load resolved to", async () => {
    await expect(guardStreamedRender(async () => "panel")).resolves.toBe(
      "panel",
    );
    expect(logger.entries).toEqual([]);
  });

  it("rethrows a redirect unwrapped", async () => {
    const thrown = redirect({ to: "/login" });

    const caught = await captureFrom(guardStreamedRender, thrown);

    expect(caught).toBe(thrown);
    expect(isRedirect(caught)).toBe(true);
    expect(logger.entries).toEqual([]);
  });

  it("rethrows a notFound unwrapped", async () => {
    const thrown = notFound();

    const caught = await captureFrom(guardStreamedRender, thrown);

    expect(caught).toBe(thrown);
    expect(isNotFound(caught)).toBe(true);
    expect(logger.entries).toEqual([]);
  });

  it("redacts a system failure and logs it raw", async () => {
    const thrown = new SystemError(
      SystemErrorCode.DatabaseError,
      INTERNAL_DETAIL,
    );

    const caught = await captureFrom(guardStreamedRender, thrown);

    expect(serializedOf(caught)).toEqual({
      kind: "system",
      code: null,
      message: "System error",
      retryable: false,
    });
    expect(logger.byLevel("error")[0]?.meta).toMatchObject({
      code: SystemErrorCode.DatabaseError,
      message: INTERNAL_DETAIL,
    });
    // The response is already committed by the time a streamed leaf throws,
    // so the status is the one thing this boundary must not pretend to fix.
    expect(mocks.statuses).toEqual([]);
  });

  // The unknown row, mirroring the middleware's "redacts an error that reached
  // the boundary unclassified": this suite's own stance is that sharing
  // `toClientError` is no reason to believe the guard redacts and logs (see the
  // brand-stripped cases below), so the unclassified path needs its own pin
  // here too.
  it("redacts a plain Error and logs it raw", async () => {
    const caught = await captureFrom(
      guardStreamedRender,
      new Error(INTERNAL_DETAIL),
    );

    expect(serializedOf(caught)).toEqual({
      kind: "unknown",
      code: null,
      message: "System error",
    });
    expect(logger.byLevel("error")[0]?.meta).toMatchObject({
      kind: "unknown",
      message: INTERNAL_DETAIL,
    });
    expect(mocks.statuses).toEqual([]);
  });

  // Server-side contract only: whether the client can still read this `code`
  // depends on the RSC boundary running the serialization adapter, which the
  // function's own JSDoc says it does not. What is pinned here is that the
  // guard itself does not collapse a classified failure on its way out.
  it("wraps a validation failure without touching its code", async () => {
    const caught = await captureFrom(guardStreamedRender, invalidCredentials());

    expect(serializedOf(caught)).toEqual({
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: LOGIN_FAILURE_MESSAGE,
      retryable: false,
      fieldErrors: { email: [LOGIN_FAILURE_MESSAGE] },
    });
    expect(logger.entries).toEqual([]);
  });

  // The half of the JSDoc contract that is not implied by sharing
  // `toClientError` with the middleware: classification survives a
  // serialization boundary here too, so the redaction and logging branches see
  // the kind the usecase earned rather than collapsing onto `unknown`. Sharing
  // an implementation is not the reason to believe that — a change that made
  // the middleware read the remnant some other way would leave this untested.
  it("classifies a brand-stripped failure the same way the middleware does", async () => {
    const serialized = serializeError(
      new ConflictError("EMAIL_ALREADY_REGISTERED", "Email already registered"),
    );
    const remnant = acrossSerializationBoundary(serialized);

    expect(isAppServerError(remnant)).toBe(false);

    const caught = await captureFrom(guardStreamedRender, remnant);

    expect(serializedOf(caught)).toEqual(serialized);
    expect(logger.entries).toEqual([]);
    // Where it differs from the middleware: the response status is already
    // committed by the time a streamed leaf throws.
    expect(mocks.statuses).toEqual([]);
  });

  // The other half of that JSDoc claim — "redaction and the `system` /
  // `unknown` logging branch see the kind the usecase earned" — needs its own
  // pin here for the same reason: only the middleware's BRAND_STRIPPED_CASES
  // exercised the `system` row before, and a change that made this guard read
  // the remnant some other way would have left it untested.
  it("logs a brand-stripped system failure raw and redacts it on the way out", async () => {
    const serialized = serializeError(
      new SystemError(SystemErrorCode.DatabaseError, INTERNAL_DETAIL),
    );
    const remnant = acrossSerializationBoundary(serialized);

    expect(isAppServerError(remnant)).toBe(false);

    const caught = await captureFrom(guardStreamedRender, remnant);

    expect(serializedOf(caught)).toEqual({
      kind: "system",
      code: null,
      message: "System error",
      retryable: false,
    });
    expect(JSON.stringify(serializedOf(caught))).not.toContain("no such table");
    expect(logger.byLevel("error")[0]?.meta).toMatchObject({
      kind: "system",
      code: SystemErrorCode.DatabaseError,
      message: INTERNAL_DETAIL,
    });
    expect(mocks.statuses).toEqual([]);
  });
});

// Spreading a real `AppServerError` keeps its `serialized` own property and
// its symbol brand; the clone then drops the symbol key, which is exactly the
// shape an error arrives in once it has crossed `structuredClone`, a JSON
// roundtrip or the Worker ↔ Durable Object RPC hop.
function acrossSerializationBoundary(serialized: SerializedError): unknown {
  return structuredClone({ ...new AppServerError(serialized) });
}

// The brand crosses a module-graph split but not a serialization boundary, so
// the boundary cannot identify a re-thrown `AppServerError` by brand alone.
// Reading the surviving payload structurally is what keeps the status the
// usecase earned: a brand-only path collapses these onto `unknown` and 500,
// which is the regression this pins.
//
// `client` is the payload the caller is allowed to see and `logged` says
// whether the failure is an operational incident. The `system` row needs both:
// the remnant stage restores a payload that was never redacted, so redaction
// runs on a value the boundary recovered rather than on one it built itself.
const BRAND_STRIPPED_CASES = [
  {
    kind: "conflict",
    status: 409,
    build: () =>
      new ConflictError("EMAIL_ALREADY_REGISTERED", "Email already registered"),
    client: {
      kind: "conflict",
      code: "EMAIL_ALREADY_REGISTERED",
      message: "Email already registered",
      retryable: false,
    },
    logged: false,
  },
  {
    kind: "validation",
    status: 422,
    build: () =>
      new ValidationError("INVALID_CREDENTIALS", LOGIN_FAILURE_MESSAGE, {
        email: [LOGIN_FAILURE_MESSAGE],
      }),
    client: {
      kind: "validation",
      code: "INVALID_CREDENTIALS",
      message: LOGIN_FAILURE_MESSAGE,
      retryable: false,
      fieldErrors: { email: [LOGIN_FAILURE_MESSAGE] },
    },
    logged: false,
  },
  {
    kind: "system",
    status: 500,
    build: () =>
      new SystemError(SystemErrorCode.DatabaseError, INTERNAL_DETAIL),
    client: {
      kind: "system",
      code: null,
      message: "System error",
      retryable: false,
    },
    logged: true,
  },
] as const satisfies ReadonlyArray<{
  readonly kind: string;
  readonly status: number;
  readonly build: () => unknown;
  readonly client: SerializedError;
  readonly logged: boolean;
}>;

describe("errorResponseMiddleware across a serialization boundary", () => {
  it.each(BRAND_STRIPPED_CASES)(
    "answers $status for a brand-stripped $kind error",
    async (testCase) => {
      const serialized = serializeError(testCase.build());
      const remnant = acrossSerializationBoundary(serialized);

      expect(isAppServerError(remnant)).toBe(false);

      const caught = await captureFrom(run, remnant);

      expect(serializedOf(caught)).toEqual(testCase.client);
      expect(mocks.statuses).toEqual([testCase.status]);

      if (!testCase.logged) {
        // Neither kind is an operational incident; logging them would drown the
        // signal the `system` / `unknown` branch exists to raise.
        expect(logger.entries).toEqual([]);
        return;
      }

      // The raw payload the remnant carried is what the operator needs, and
      // exactly what the client must not get.
      expect(logger.byLevel("error")[0]?.meta).toMatchObject({
        kind: "system",
        code: SystemErrorCode.DatabaseError,
        message: INTERNAL_DETAIL,
      });

      const wire = JSON.stringify(serializedOf(caught));

      expect(wire).not.toContain("D1_ERROR");
      expect(wire).not.toContain("no such table");
      expect(wire).not.toContain("/var/task");
      expect(wire).not.toContain(SystemErrorCode.DatabaseError);
    },
  );

  // The counterweight: reading the remnant structurally must not turn any
  // object with a `serialized` key into a trusted status. A payload the union
  // does not recognise still fails closed onto 500.
  it("still fails closed to 500 when the surviving payload is malformed", async () => {
    const caught = await captureFrom(
      run,
      structuredClone({
        name: "AppServerError",
        serialized: { kind: "not-a-kind", message: "x" },
      }),
    );

    expect(extractSerializedError(caught)).toEqual({
      kind: "unknown",
      code: null,
      message: "System error",
    });
    expect(mocks.statuses).toEqual([500]);
    expect(logger.byLevel("error")).toHaveLength(1);
  });
});
