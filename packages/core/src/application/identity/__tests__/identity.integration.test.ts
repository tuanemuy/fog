import { env, runInDurableObject } from "cloudflare:test";
import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { setupTestContainer } from "../../__tests__/helpers";
import {
  isConflictError,
  isForbiddenError,
  isUnauthorizedError,
  isValidationError,
} from "../../errors";
import { getCurrentUser } from "../getCurrentUser";
import { loginWithPassword } from "../loginWithPassword";
import { registerWithPassword } from "../registerWithPassword";
import { requestPasswordReset } from "../requestPasswordReset";

/**
 * The identity usecases against the two real Durable Object namespaces.
 *
 * Everything goes through `createRequestContainer`, so the Durable Object
 * selection point stays where the architecture says it is and the suite
 * exercises the same wiring production does — stub-error translation and value
 * envelopes included.
 */

const container = setupTestContainer();

let seq = 0;
function address(): string {
  seq += 1;
  return `user-${seq}@example.com`;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** Reads inside a user's DO without going through an entry point. */
function inUserDataOf<T>(
  userId: string,
  fn: (sql: SqlStorage) => T,
): Promise<T> {
  const ns = env.USER_DATA;
  return runInDurableObject(ns.get(ns.idFromName(userId)), (_i, ctx) =>
    fn(ctx.storage.sql as SqlStorage),
  ) as Promise<T>;
}

describe("registerWithPassword", () => {
  it("creates an account reachable by the credential it registered", async () => {
    const email = address();
    const registered = await registerWithPassword({
      container: container(),
      input: { email, password: "correct horse battery staple" },
    });
    expect(registered.userId).not.toBe("");

    const view = await getCurrentUser({
      container: container(),
      input: { userId: registered.userId, epoch: registered.sessionEpoch },
    });
    expect(view.userId).toBe(registered.userId);
    expect(view.credentials).toHaveLength(1);
    expect(view.credentials[0]?.kind).toBe("email");
    // An email credential is a way in exactly while it holds a verifier, which
    // is what keeps an SSO-only account's address reservation from counting.
    expect(view.credentials[0]?.usableForLogin).toBe(true);
    // The label is fixed to the empty string by contract: putting the address
    // there would copy PII into the User Data DO.
    expect(view.credentials[0]?.label).toBe("");
  });

  it("finishes the saga: the operation reaches phase done in one transaction", async () => {
    const registered = await registerWithPassword({
      container: container(),
      input: { email: address(), password: "correct horse battery staple" },
    });
    const rows = await inUserDataOf(registered.userId, (sql) => ({
      operations: sql
        .exec<{ phase: string; target_locators: string | null }>(
          "SELECT phase, target_locators FROM operations",
        )
        .toArray(),
      locators: sql
        .exec<{ credential_id: string }>(
          "SELECT credential_id FROM credential_locators",
        )
        .toArray(),
    }));
    expect(rows.operations).toHaveLength(1);
    expect(rows.operations[0]?.phase).toBe("done");
    // The locator row and `phase = 'done'` are written together. Split into two
    // RPCs they would leave a stable state in which login's reachability check
    // passes while the operation still reads `activating`.
    expect(rows.locators).toHaveLength(1);
    // Forward-compatibility point: the stashed locators are the only reverse
    // information a recovery has, so nothing clears them at the terminus.
    expect(rows.operations[0]?.target_locators).not.toBeNull();
  });

  it("refuses a second registration of the same address", async () => {
    const email = address();
    const input = { email, password: "correct horse battery staple" };
    await registerWithPassword({ container: container(), input });
    const error = await caught(() =>
      registerWithPassword({ container: container(), input }),
    );
    expect(isConflictError(error)).toBe(true);
  });

  it("mints a fresh operation per attempt rather than reusing one", async () => {
    const first = await registerWithPassword({
      container: container(),
      input: { email: address(), password: "correct horse battery staple" },
    });
    const second = await registerWithPassword({
      container: container(),
      input: { email: address(), password: "correct horse battery staple" },
    });
    // Nothing the client sent decides either id. A client-supplied idempotency
    // key would become the argument to `idFromName`.
    expect(first.userId).not.toBe(second.userId);
  });
});

describe("loginWithPassword", () => {
  const password = "correct horse battery staple";

  it("signs in with the registered credential", async () => {
    const email = address();
    const registered = await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    const signedIn = await loginWithPassword({
      container: container(),
      input: { email, password },
    });
    expect(signedIn.userId).toBe(registered.userId);
    expect(signedIn.sessionEpoch).toBe(registered.sessionEpoch);
  });

  it("answers an unknown address exactly like a wrong password", async () => {
    const email = address();
    await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    const wrongPassword = await caught(() =>
      loginWithPassword({
        container: container(),
        input: { email, password: "not the password" },
      }),
    );
    const unknownAddress = await caught(() =>
      loginWithPassword({
        container: container(),
        input: { email: address(), password },
      }),
    );
    // Same class and same message: which of the two happened must not be
    // recoverable from the answer.
    expect(isValidationError(wrongPassword)).toBe(true);
    expect(isValidationError(unknownAddress)).toBe(true);
    expect((wrongPassword as Error).message).toBe(
      (unknownAddress as Error).message,
    );
  });

  it("reports both outcomes back to the bucket", async () => {
    const email = address();
    await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    const locator = (await container().directoryLocator.forCanonical(email))[0];
    if (locator === undefined) throw new Error("no locator");

    const readAttempts = () => {
      const ns = env.IDENTITY_DIRECTORY;
      return runInDurableObject(
        ns.get(ns.idFromName(locator.doName)),
        (_i, ctx) =>
          (ctx.storage.sql as SqlStorage)
            .exec<{ failed_attempts: number }>(
              "SELECT failed_attempts FROM credential_mappings WHERE hmac = ?",
              locator.hmac,
            )
            .toArray()[0]?.failed_attempts ?? -1,
      ) as Promise<number>;
    };

    await caught(() =>
      loginWithPassword({
        container: container(),
        input: { email, password: "not the password" },
      }),
    );
    expect(await readAttempts()).toBe(1);

    // The same report also opened a throttle window, and a throttled row is
    // levelled to "no usable material" — so even the right password is refused
    // until it passes. Step out of the window to reach the success path.
    const ns = env.IDENTITY_DIRECTORY;
    await runInDurableObject(ns.get(ns.idFromName(locator.doName)), (_i, ctx) =>
      (ctx.storage.sql as SqlStorage).exec(
        "UPDATE credential_mappings SET next_attempt_allowed_at = NULL WHERE hmac = ?",
        locator.hmac,
      ),
    );

    // Success clears the counter, and the report is awaited before responding:
    // a failure report a caller could dodge by dropping the connection would
    // not deter anything.
    await loginWithPassword({
      container: container(),
      input: { email, password },
    });
    expect(await readAttempts()).toBe(0);
  });

  it("refuses a credential the account no longer reaches", async () => {
    const email = address();
    const registered = await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    // Stands in for an orphan mapping: the Directory still maps the credential
    // while this side has let go of it.
    await inUserDataOf(registered.userId, (sql) => {
      sql.exec("DELETE FROM credential_locators");
    });
    const error = await caught(() =>
      loginWithPassword({ container: container(), input: { email, password } }),
    );
    expect(isUnauthorizedError(error)).toBe(true);
  });

  it("refuses a credential whose version has moved on", async () => {
    const email = address();
    const registered = await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    await inUserDataOf(registered.userId, (sql) => {
      sql.exec(
        "UPDATE credential_locators SET credential_version = credential_version + 1",
      );
    });
    const error = await caught(() =>
      loginWithPassword({ container: container(), input: { email, password } }),
    );
    expect(isUnauthorizedError(error)).toBe(true);
  });
});

describe("the session epoch guard", () => {
  it("rejects a token minted before the epoch advanced", async () => {
    const registered = await registerWithPassword({
      container: container(),
      input: { email: address(), password: "correct horse battery staple" },
    });
    await inUserDataOf(registered.userId, (sql) => {
      sql.exec("UPDATE account SET session_epoch = session_epoch + 1");
    });
    const error = await caught(() =>
      getCurrentUser({
        container: container(),
        input: { userId: registered.userId, epoch: registered.sessionEpoch },
      }),
    );
    // The cookie is still perfectly well signed. Authority over revocation is
    // the DO's, not the request Worker's.
    expect(isUnauthorizedError(error)).toBe(true);
  });

  it("rejects a session on an account that is no longer active", async () => {
    const registered = await registerWithPassword({
      container: container(),
      input: { email: address(), password: "correct horse battery staple" },
    });
    await inUserDataOf(registered.userId, (sql) => {
      sql.exec("UPDATE account SET status = 'deleting'");
    });
    const error = await caught(() =>
      getCurrentUser({
        container: container(),
        input: { userId: registered.userId, epoch: registered.sessionEpoch },
      }),
    );
    expect(isForbiddenError(error)).toBe(true);
  });
});

describe("requestPasswordReset", () => {
  it("writes exactly one job row whether or not the address is registered", async () => {
    const registeredAddress = address();
    await registerWithPassword({
      container: container(),
      input: {
        email: registeredAddress,
        password: "correct horse battery staple",
      },
    });
    const unknownAddress = address();

    const jobsFor = async (email: string) => {
      const locator = (
        await container().directoryLocator.forCanonical(email)
      )[0];
      if (locator === undefined) throw new Error("no locator");
      const ns = env.IDENTITY_DIRECTORY;
      return runInDurableObject(
        ns.get(ns.idFromName(locator.doName)),
        (_i, ctx) =>
          (ctx.storage.sql as SqlStorage)
            .exec<{ kind: string; operation_key: string }>(
              "SELECT kind, operation_key FROM jobs WHERE kind = 'send-mail'",
            )
            .toArray(),
      ) as Promise<{ kind: string; operation_key: string }[]>;
    };

    await requestPasswordReset({
      container: container(),
      input: { email: registeredAddress },
    });
    await requestPasswordReset({
      container: container(),
      input: { email: unknownAddress },
    });

    // Identical row count and identical shape: the difference between the two
    // is confined to what the send resolves later, so the enqueue itself is not
    // an enumeration oracle.
    expect(await jobsFor(registeredAddress)).toHaveLength(1);
    expect(await jobsFor(unknownAddress)).toHaveLength(1);
  });
});
