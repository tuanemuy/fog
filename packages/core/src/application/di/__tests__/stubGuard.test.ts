import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { content } from "@repo/core/config";
import { describe, expect, it } from "vitest";
import {
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "../secrets";
import { createRequestContainer } from "../serverCloudflare";

// The stub guard the composition root wraps every Durable Object stub in.
//
// `translateStubError` has unit tests of its own; what needs exercising here is
// the wiring that is supposed to call it.
//
// So the fixture below is the whole point of this file. A workerd JS RPC call
// returns `Rpc.Result<R>` — a custom thenable that is not a `Promise` — and a
// fake built out of `async` methods would reproduce the translation while
// leaving the wiring untested: a guard that recognises a pending call by
// `instanceof Promise` passes against such a fake and translates **only** a
// synchronous throw of a real one.

const SESSION_SECRET = requireSessionSecret("0123456789abcdef0123456789abcdef");
const AI_CLIENT_TOKEN_SECRET = requireAiClientTokenSecret(
  "ai-client-0123456789abcdef0123456789abcdef",
);
const DIRECTORY_ROUTING_KEYRING = requireDirectoryRoutingKeyring(
  JSON.stringify([
    {
      generation: 1,
      key: "routing-0123456789abcdef0123456789abcdef",
      bucketCount: 256,
    },
  ]),
);

/**
 * Stands in for `Rpc.Result<R>`: settles like a promise, is not one.
 *
 * Two properties of the real handle are reproduced deliberately, because a
 * guard can miss it on either. It is not derived from `Promise`, so
 * `instanceof Promise` is false; and it is **callable**, so `typeof` it is
 * `"function"` rather than `"object"` — the result doubles as the pipelining
 * provider. Both are measured against a live stub in the integration suite.
 */
function rpcResult<T>(settle: () => Promise<T>): PromiseLike<T> {
  const pipeline = () => {
    throw new Error("the facades do not pipeline");
  };
  return Object.assign(pipeline, {
    // A hand-rolled `then` on something that is not a `Promise` is the subject
    // of this fixture rather than an accident: recognising that shape is the
    // whole job of the guard under test.
    // biome-ignore lint/suspicious/noThenProperty: thenable on purpose
    then(
      onFulfilled?: ((value: T) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) {
      return settle().then(onFulfilled, onRejected);
    },
  }) as unknown as PromiseLike<T>;
}

type StubMethods = Record<string, (...args: unknown[]) => unknown>;

function namespaceOf(stub: StubMethods) {
  return {
    idFromName(name: string) {
      return { name };
    },
    get() {
      return stub;
    },
  } as never;
}

function stubbedContainer(stub: StubMethods) {
  return createRequestContainer({
    ...content,
    appUrl: "http://localhost:3000",
    bindings: {
      userData: namespaceOf(stub),
      identityDirectory: namespaceOf(stub),
    },
    secrets: {
      sessionSecret: SESSION_SECRET,
      aiClientTokenSecret: AI_CLIENT_TOKEN_SECRET,
      directoryRoutingKeyring: DIRECTORY_ROUTING_KEYRING,
    },
  });
}

function guarded(stub: StubMethods): StubMethods {
  return stubbedContainer(stub).userDataStubFactory(
    "user-1",
  ) as unknown as StubMethods;
}

async function caught(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("the guarded call was expected to fail");
}

describe("the composition root's stub guard", () => {
  it("keeps the fixture shaped like a real RPC result, not like a Promise", () => {
    // Negative control for every asynchronous case below. If this ever becomes
    // a real `Promise`, they all keep passing while testing nothing — and the
    // `typeof` line is not decoration either: an "object"-only thenable check
    // passes here and misses every real call.
    const result = rpcResult(async () => 1);
    expect(result instanceof Promise).toBe(false);
    expect(typeof result).toBe("function");
    expect(typeof result.then).toBe("function");
  });

  it("translates a failure that arrives as a rejected RPC result", async () => {
    const error = await caught(() =>
      guarded({
        getCurrentUser: () =>
          rpcResult(() => {
            throw new Error(
              'Worker "fog-state" not found. Make sure it is running locally.',
            );
          }),
      }).getCurrentUser("user-1", 1),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe(
      SystemErrorCode.DatabaseError,
    );
  });

  it("carries the overloaded marker through the asynchronous path", async () => {
    // The retryable/not-retryable split is the one operational signal the
    // translation adds, and it is only reachable from a rejection.
    const error = await caught(() =>
      guarded({
        verifyLogin: () =>
          rpcResult(() =>
            Promise.reject(
              Object.assign(new Error("overloaded"), { overloaded: true }),
            ),
          ),
      }).verifyLogin({}),
    );

    expect(isSystemError(error) && error.code).toBe(
      SystemErrorCode.ServiceOverloaded,
    );
  });

  it("still translates a failure thrown by the call itself", async () => {
    const error = await caught(() =>
      guarded({
        getCurrentUser: () => {
          throw new Error("Network connection lost.");
        },
      }).getCurrentUser("user-1", 1),
    );

    expect(isSystemError(error) && error.code).toBe(
      SystemErrorCode.DatabaseError,
    );
  });

  it("passes a successful envelope through untouched", async () => {
    const envelope = { ok: true, value: { userId: "user-1" } };
    const returned = await guarded({
      getCurrentUser: () => rpcResult(async () => envelope),
    }).getCurrentUser("user-1", 1);

    expect(returned).toStrictEqual(envelope);
  });

  it("leaves a synchronously returned envelope synchronous", () => {
    // `readSchemaVersion` is declared as either, and it is the DO class — not
    // the stub — that answers in place when a test holds the instance.
    const envelope = { ok: true, value: 1 };
    expect(
      guarded({ readSchemaVersion: () => envelope }).readSchemaVersion(),
    ).toBe(envelope);
  });

  it("does not treat a non-function property as a call", () => {
    const stub = { name: "not-callable" } as unknown as StubMethods;
    expect(guarded(stub).name).toBe("not-callable");
  });
});
