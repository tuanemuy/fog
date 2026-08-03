import { env } from "cloudflare:test";
import { isSystemError, SystemErrorCode } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { createTestContainer } from "../../__tests__/helpers";
import type { UserDataFacade } from "../facades";

// The half of the stub guard that no fake can vouch for: the shape workerd's
// JS RPC actually hands back.
//
// `stubGuard.test.ts` models that shape with a fake; this measures the real
// object, and the raw stub beside the guarded one is the negative control: the
// guard has to interpose on the asynchronous path, and only a translation
// attached to *that* handle does.

const USER_ID = "00000000-0000-7000-8000-0000000000f0";

function rawStub(): UserDataFacade {
  const ns = env.USER_DATA;
  // Direct addressing, which only a test may do: the point here is to hold
  // the unguarded stub next to the guarded one.
  return ns.get(ns.idFromName(USER_ID)) as unknown as UserDataFacade;
}

async function caught(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("the guarded call was expected to fail");
}

describe("the stub guard over a real Durable Object stub", () => {
  it("interposes on the handle workerd returns, which is not a Promise", async () => {
    const raw = rawStub().readSchemaVersion();

    // Measured, not assumed: `[object JsRpcPromise]`, `instanceof Promise`
    // false, `then` present. This is why the guard cannot test by identity.
    expect(raw instanceof Promise).toBe(false);
    expect(Object.prototype.toString.call(raw)).toBe("[object JsRpcPromise]");
    expect(typeof (raw as PromiseLike<unknown>).then).toBe("function");
    await raw;

    const guarded = createTestContainer()
      .userDataStubFactory(USER_ID)
      .readSchemaVersion();

    expect(guarded instanceof Promise).toBe(true);
    expect(await guarded).toMatchObject({ ok: true });
  });

  it("translates a real asynchronous failure of the call itself", async () => {
    // A `Symbol` argument is deliberately outside the facade's contract
    // ("primitives in"), and that is what makes it usable here: workerd stubs
    // a function argument out and lets it through, but a `Symbol` cannot be
    // structured-cloned, so the returned handle *rejects* with `DataCloneError`
    // before the call ever reaches the Durable Object.
    //
    // That is the one failure mode the envelope cannot express — the DO's RPC
    // entry answers in-DO failures with `{ ok: false, error }`, so only a call
    // that never arrives fails asynchronously — and it is exactly what the
    // guard exists to translate. `stubGuard.test.ts` sees the translation
    // against a fake; this sees it against workerd.
    const facade = createTestContainer().userDataStubFactory(USER_ID);

    const error = await caught(() =>
      facade.getCurrentUser(Symbol("not-cloneable") as never, 1),
    );

    expect(isSystemError(error)).toBe(true);
    expect(isSystemError(error) && error.code).toBe(
      SystemErrorCode.DatabaseError,
    );
  });
});
