import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTestContainer } from "../../__tests__/helpers";
import type { UserDataFacade } from "../facades";

// The half of the stub guard that no fake can vouch for: the shape workerd's
// JS RPC actually hands back.
//
// `stubGuard.test.ts` models it, and a model is exactly what went wrong — the
// guard recognised a pending call with `instanceof Promise`, which is false for
// a real stub call, so every asynchronous Durable Object failure escaped
// untranslated. This measures the real object instead, and the raw stub beside
// the guarded one is the negative control: the guard has to interpose on the
// asynchronous path, and only a translation attached to *that* handle does.

const USER_ID = "00000000-0000-7000-8000-0000000000f0";

function rawStub(): UserDataFacade {
  const ns = env.USER_DATA;
  // Direct addressing, which only a test may do (ADR-028): the point here is
  // to hold the unguarded stub next to the guarded one.
  return ns.get(ns.idFromName(USER_ID)) as unknown as UserDataFacade;
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
});
