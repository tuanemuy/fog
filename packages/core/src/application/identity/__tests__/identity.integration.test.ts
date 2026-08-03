import { env, runInDurableObject } from "cloudflare:test";
import type {
  DurableObjectState,
  SqlStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types";
import { IDENTITY_DIRECTORY_JOB_HANDLERS } from "@repo/core/adapters/cloudflare/jobs/registry";
import { runDueJobs } from "@repo/core/adapters/cloudflare/jobs/runner";
import {
  createPbkdf2PasswordHasher,
  MIN_PBKDF2_ITERATIONS,
} from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import type {
  Email,
  SsoProvider,
} from "@repo/core/domain/identity/valueObject";
import { ssoCanonical } from "@repo/core/domain/identity/valueObject";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import { disarm } from "../../../adapters/cloudflare/__tests__/doHarness";
import {
  createTestContainer,
  setupTestContainer,
} from "../../__tests__/helpers";
import type { InitializeAccountArgs, UserDataFacade } from "../../di/facades";
import { requireKeyring, type StateSecrets } from "../../di/secrets";
import type { RequestContainer } from "../../di/types";
import {
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isUnauthorizedError,
  isValidationError,
} from "../../errors";
import { getCurrentUser } from "../getCurrentUser";
import { loginWithPassword } from "../loginWithPassword";
import { registerWithPassword } from "../registerWithPassword";
import { requestPasswordReset } from "../requestPasswordReset";
import { runSignupSaga } from "../signupSaga";

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

/** The same, for the bucket an address routes to. */
async function inDirectoryOf<T>(
  email: string,
  fn: (sql: SqlStorage, ctx: DurableObjectState) => T,
): Promise<T> {
  const locator = (await container().directoryLocator.forCanonical(email))[0];
  if (locator === undefined) throw new Error("no locator");
  const ns = env.IDENTITY_DIRECTORY;
  return runInDurableObject(ns.get(ns.idFromName(locator.doName)), (_i, ctx) =>
    fn(ctx.storage.sql as SqlStorage, ctx as DurableObjectState),
  ) as Promise<T>;
}

/**
 * The mapping rows an address's own active locator addresses.
 *
 * Filtered on the hmac rather than reading the whole table: two addresses in
 * one test can legitimately share a bucket (there are 256 of them), so an
 * unfiltered `SELECT` makes the assertion depend on which pair the run drew.
 */
async function mappingRowsFor<T extends Record<string, SqlStorageValue>>(
  email: string,
  columns: string,
): Promise<T[]> {
  const locator = (await container().directoryLocator.forCanonical(email))[0];
  if (locator === undefined) throw new Error("no locator");
  return inDirectoryOf(email, (sql) =>
    sql
      .exec<T>(
        `SELECT ${columns} FROM credential_mappings WHERE kind = 'email' AND hmac = ?`,
        locator.hmac,
      )
      .toArray(),
  );
}

/** The state Worker's keyrings, as `vitest.config.integration.ts` binds them. */
function stateSecrets(): StateSecrets {
  return {
    mailEncryptionKeyring: requireKeyring(
      env.IDENTITY_MAIL_ENCRYPTION_KEY,
      "IDENTITY_MAIL_ENCRYPTION_KEY",
      { requireBucketCount: false },
    ),
    resetTokenKeyring: requireKeyring(
      env.IDENTITY_RESET_TOKEN_KEY,
      "IDENTITY_RESET_TOKEN_KEY",
      { requireBucketCount: false },
    ),
  };
}

/**
 * Asks for a reset link and then takes the bucket's alarm away from the
 * platform.
 *
 * The usecase's RPC ends in `armAfterRpc`, and the `send-mail` row it queued is
 * due immediately, so the clamp arms a genuine alarm one second out. The
 * Durable Object's own wake-up would then run the row with the *noop* sender —
 * an unbound `MAIL_SENDER` is what this suite runs with — and `deliverDueMail`
 * below would find nothing to send and report no recipient. The window is one
 * second wide, so the assertions pass on a fast run and fail on a slow one;
 * disarming is what makes the observation the test's own. See `disarm`.
 */
async function askForResetLink(email: string): Promise<void> {
  await requestPasswordReset({ container: container(), input: { email } });
  const locator = (await container().directoryLocator.forCanonical(email))[0];
  if (locator === undefined) throw new Error("no locator");
  const ns = env.IDENTITY_DIRECTORY;
  await disarm(ns.get(ns.idFromName(locator.doName)));
}

/**
 * Runs the bucket's due jobs against a recording sender and reports every
 * recipient. The DO's own `alarm()` would use the noop sender — an unbound
 * `MAIL_SENDER` is what the suite runs with — so the send has to be driven with
 * a sender the test can read.
 */
async function deliverDueMail(email: string): Promise<string[]> {
  const sent: string[] = [];
  const now = Date.now();
  await inDirectoryOf(email, (sql, ctx) =>
    runDueJobs(
      {
        ctx,
        sql,
        now,
        ownerToken: "test-owner",
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        idGenerator: container().idGenerator,
        mailSender: {
          sendPasswordResetMail: (to: Email) => {
            sent.push(to);
            return Promise.resolve();
          },
        },
        appUrl: "http://localhost:8787",
        secrets: stateSecrets(),
      },
      IDENTITY_DIRECTORY_JOB_HANDLERS,
      now,
    ),
  );
  return sent;
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
    // The settings row `initialize` wrote carries the domain default, and the
    // projection carries it out again — the only two places it can be lost.
    expect(view.trashRetentionDays).toBe(30);
  });

  it("keeps the password plaintext out of the stored verifier", async () => {
    const email = address();
    const password = "correct horse battery staple";
    await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    const verifier =
      (
        await mappingRowsFor<{ password_verifier: string | null }>(
          email,
          "password_verifier",
        )
      )[0]?.password_verifier ?? null;
    // The row is the one place a hash is read off, and `FakePasswordHasher`
    // deliberately does not embed the plaintext — so this assertion is the
    // property that justifies substituting the fake at all. A fake that
    // prefixed the password would make it hold by accident, which is why the
    // real hasher is exercised over the same route below.
    expect(verifier).not.toBeNull();
    expect(verifier).not.toContain(password);
    for (const word of password.split(" ")) {
      expect(verifier).not.toContain(word);
    }
  });

  it("round-trips a password through the real PBKDF2 hasher", async () => {
    // The one test that pays for a genuine key derivation. `FakePasswordHasher`
    // is justified by the WebCrypto adapter being unit-tested separately *and*
    // by one end-to-end round trip through real storage; without this, nothing
    // proves the shipped hasher's encoding survives the mapping row's column.
    const real = createTestContainer({
      passwordHasher: createPbkdf2PasswordHasher({
        iterations: MIN_PBKDF2_ITERATIONS,
      }),
    });
    const email = address();
    const password = "an 8+ character password";
    const registered = await registerWithPassword({
      container: real,
      input: { email, password },
    });
    const verifier =
      (
        await mappingRowsFor<{ password_verifier: string | null }>(
          email,
          "password_verifier",
        )
      )[0]?.password_verifier ?? null;
    expect(verifier).toMatch(
      new RegExp(`^pbkdf2-sha256\\$${MIN_PBKDF2_ITERATIONS}\\$`),
    );
    expect(verifier).not.toContain(password);

    const signedIn = await loginWithPassword({
      container: real,
      input: { email, password },
    });
    expect(signedIn.userId).toBe(registered.userId);
    const wrong = await caught(() =>
      loginWithPassword({
        container: real,
        input: { email, password: "an 8+ character passworC" },
      }),
    );
    expect(isValidationError(wrong)).toBe(true);
  });

  it("detects a duplicate that only matches after normalisation", async () => {
    const email = address();
    await registerWithPassword({
      container: container(),
      input: { email, password: "correct horse battery staple" },
    });
    // The unit tests pin `Email.create`'s canonicalisation, but not that the
    // routing chain consumes the canonical: derive the HMAC from the raw input
    // instead and the two spellings land in different buckets, while every
    // value-object test stays green.
    const error = await caught(() =>
      registerWithPassword({
        container: container(),
        input: {
          email: `  ${email.toUpperCase()}  `,
          password: "correct horse battery staple",
        },
      }),
    );
    expect(isConflictError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMAIL_ALREADY_REGISTERED");
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

  it("seals the address original into the bucket's mapping row", async () => {
    const email = address();
    await registerWithPassword({
      container: container(),
      input: { email, password: "correct horse battery staple" },
    });
    const row = await inDirectoryOf(
      email,
      (sql) =>
        sql
          .exec<{
            encrypted_canonical: string | null;
            encryption_generation: number | null;
            encryption_nonce: string | null;
          }>(
            `SELECT encrypted_canonical, encryption_generation, encryption_nonce
               FROM credential_mappings`,
          )
          .toArray()[0],
    );
    // The row is the only place the address survives, and the reservation is
    // the only write that can put it there.
    expect(row?.encrypted_canonical).toMatch(/^[0-9a-f]+$/);
    expect(row?.encryption_generation).toBe(1);
    // 96 bits, in its own column rather than concatenated onto the ciphertext.
    expect(row?.encryption_nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(row?.encrypted_canonical).not.toContain(email);
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

  it("answers all four rejections in exactly the same shape", async () => {
    const email = address();
    await registerWithPassword({
      container: container(),
      input: { email, password },
    });

    const shapeOf = async (input: {
      email: string;
      password: string;
    }): Promise<string> => {
      const error = await caught(() =>
        loginWithPassword({ container: container(), input }),
      );
      return JSON.stringify({
        validation: isValidationError(error),
        name: (error as Error).name,
        code: (error as { code?: string }).code ?? null,
        message: (error as Error).message,
      });
    };

    // Two of these never reach the Directory at all: a malformed address and a
    // seven-character password fail value-object construction, and the usecase
    // folds both onto `INVALID_CREDENTIALS` rather than letting
    // `BusinessRuleError(InvalidEmail)` / `PasswordTooWeak` out. Comparing all
    // four against one expected value is what makes the check an enumeration
    // oracle test rather than four independent assertions that could drift.
    const expected = await shapeOf({ email, password: "not the password" });
    expect(JSON.parse(expected).code).toBe("INVALID_CREDENTIALS");
    expect(await shapeOf({ email: address(), password })).toBe(expected);
    expect(await shapeOf({ email: "not-an-address", password })).toBe(expected);
    expect(await shapeOf({ email, password: "7 chars" })).toBe(expected);
  });

  it("matches on the normalised address", async () => {
    const email = address();
    const registered = await registerWithPassword({
      container: container(),
      input: { email, password },
    });
    // Same property as the duplicate-registration case, from the read side:
    // canonicalisation has to happen before the HMAC, in login as in signup.
    const signedIn = await loginWithPassword({
      container: container(),
      input: { email: `  ${email.toUpperCase()}  `, password },
    });
    expect(signedIn.userId).toBe(registered.userId);
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

  it("reports a live session whose settings row is gone as USER_NOT_FOUND", async () => {
    const registered = await registerWithPassword({
      container: container(),
      input: { email: address(), password: "correct horse battery staple" },
    });
    // The account row is untouched, so the epoch and status guards both pass:
    // this is the one branch that separates "not your session" from "the
    // aggregate this session names is missing", and it answers with a
    // different error class on purpose.
    await inUserDataOf(registered.userId, (sql) => {
      sql.exec("DELETE FROM user_settings");
    });
    const error = await caught(() =>
      getCurrentUser({
        container: container(),
        input: { userId: registered.userId, epoch: registered.sessionEpoch },
      }),
    );
    expect(isNotFoundError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("USER_NOT_FOUND");
  });
});

describe("changeTrashRetentionDays", () => {
  const password = "correct horse battery staple";
  const DAY = 24 * 60 * 60 * 1000;

  async function registeredUser(): Promise<{
    userId: string;
    epoch: number;
    facade: UserDataFacade;
  }> {
    const registered = await registerWithPassword({
      container: container(),
      input: { email: address(), password },
    });
    return {
      userId: registered.userId,
      epoch: registered.sessionEpoch,
      facade: container().userDataStubFactory(registered.userId),
    };
  }

  function addTrashedMemo(userId: string, trashedAt: number): Promise<void> {
    return inUserDataOf(userId, (sql) => {
      sql.exec(
        `INSERT INTO memos (id, body, latest_revision_number, posted_at, status,
                            trashed_at, purge_after, version, updated_at)
         VALUES ('m1', 'body', 1, 0, 'trashed', ?, ?, 1, 0)`,
        trashedAt,
        trashedAt + 30 * DAY,
      );
    });
  }

  it("recomputes every trashed item and queues the sweep in one transaction", async () => {
    const { userId, epoch, facade } = await registeredUser();
    const trashedAt = Date.now() - 3 * DAY;
    await addTrashedMemo(userId, trashedAt);

    const answered = await facade.changeTrashRetentionDays(userId, epoch, 7);
    expect(answered.ok).toBe(true);
    expect(answered.ok && answered.value.trashRetentionDays).toBe(7);

    // Read back at the moment the RPC returned. The recomputation is not a
    // job's tail here — the row is already on the new window — and the
    // `purge-trash` row is already queued, both because the facade does them
    // inside the same `uow.run` as the settings save.
    const after = await inUserDataOf(userId, (sql) => ({
      purgeAfter:
        sql
          .exec<{ purge_after: number | null }>(
            "SELECT purge_after FROM memos WHERE id = 'm1'",
          )
          .toArray()[0]?.purge_after ?? null,
      jobs: sql
        .exec<{ operation_key: string; kind: string }>(
          "SELECT operation_key, kind FROM jobs",
        )
        .toArray(),
      settings: sql
        .exec<{ trash_retention_days: number; version: number }>(
          "SELECT trash_retention_days, version FROM user_settings",
        )
        .toArray()[0],
    }));
    expect(after.purgeAfter).toBe(trashedAt + 7 * DAY);
    expect(after.jobs).toEqual([
      { operation_key: "purge-trash", kind: "purge-trash" },
    ]);
    expect(after.settings?.trash_retention_days).toBe(7);
    expect(after.settings?.version).toBe(1);
  });

  it("burns no OCC round trip when the value has not moved", async () => {
    const { userId, epoch, facade } = await registeredUser();
    const before = await inUserDataOf(
      userId,
      (sql) =>
        sql
          .exec<{ version: number }>("SELECT version FROM user_settings")
          .toArray()[0]?.version ?? -1,
    );
    const answered = await facade.changeTrashRetentionDays(userId, epoch, 30);
    expect(answered.ok).toBe(true);

    const after = await inUserDataOf(userId, (sql) => ({
      version:
        sql
          .exec<{ version: number }>("SELECT version FROM user_settings")
          .toArray()[0]?.version ?? -1,
      jobs: sql.exec("SELECT operation_key FROM jobs").toArray().length,
    }));
    // Identity, not equality: re-posting the current value must not bump the
    // version, or a settings screen that re-submits its form starts losing
    // races against concurrent writers for no reason.
    expect(after.version).toBe(before);
    // …and the early return happens before the enqueue, so no wake-up is bought
    // for a change that did not happen.
    expect(after.jobs).toBe(0);
  });

  it("refuses a stale session before touching anything", async () => {
    const { userId, epoch, facade } = await registeredUser();
    const answered = await facade.changeTrashRetentionDays(
      userId,
      epoch + 1,
      7,
    );
    expect(answered.ok).toBe(false);
    const after = await inUserDataOf(
      userId,
      (sql) =>
        sql
          .exec<{ trash_retention_days: number }>(
            "SELECT trash_retention_days FROM user_settings",
          )
          .toArray()[0]?.trash_retention_days ?? -1,
    );
    expect(after).toBe(30);
  });
});

describe("the signup saga under partial failure", () => {
  const password = "correct horse battery staple";

  /**
   * A container whose User Data stub fails phase 2 in one named way.
   *
   * The delegation is written out rather than spread: the real value is a
   * Workers RPC stub, a proxy with no own enumerable properties, so
   * `{ ...stub }` produces an empty object and every other entry would be
   * `undefined` at the moment the saga reached it.
   */
  function withInitializeAccount(
    base: RequestContainer,
    replacement: (
      real: UserDataFacade,
      args: InitializeAccountArgs,
    ) => Promise<RpcEnvelope<null>>,
  ): RequestContainer {
    return {
      ...base,
      userDataStubFactory: (userId: string) => {
        const real = base.userDataStubFactory(userId);
        const wrapped: UserDataFacade = {
          getCurrentUser: (id, epoch) => real.getCurrentUser(id, epoch),
          changeTrashRetentionDays: (id, epoch, days) =>
            real.changeTrashRetentionDays(id, epoch, days),
          initializeAccount: (args) => replacement(real, args),
          verifyLogin: (args) => real.verifyLogin(args),
          recordCredentialLocator: (args) => real.recordCredentialLocator(args),
          readSchemaVersion: () => real.readSchemaVersion(),
        };
        return wrapped;
      },
    };
  }

  it("rolls the coordinator's reservation back when a later bucket refuses", async () => {
    const subject = `subject-${seq}-4711`;
    const first = address();
    const second = address();
    const ssoCredential = {
      kind: "sso" as const,
      canonical: ssoCanonical("google" as SsoProvider, subject),
      label: "google",
    };
    await runSignupSaga(container(), [
      { kind: "email", canonical: first, label: "", passwordVerifier: "v1" },
      ssoCredential,
    ]);

    // `second` is free; the SSO identity is not. Ordering is `email < sso`, so
    // the email bucket is the coordinator and is reserved first — phase 1b then
    // loses, and the compensation has to unwind phase 1a.
    const error = await caught(() =>
      runSignupSaga(container(), [
        { kind: "email", canonical: second, label: "", passwordVerifier: "v2" },
        ssoCredential,
      ]),
    );
    expect(isConflictError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "SSO_IDENTITY_ALREADY_REGISTERED",
    );

    const rows = await mappingRowsFor(second, "credential_id");
    expect(rows).toHaveLength(0);
    // The observable consequence, not just the row count: the address the lost
    // saga touched is registrable again.
    const recovered = await registerWithPassword({
      container: container(),
      input: { email: second, password },
    });
    expect(recovered.userId).not.toBe("");
  });

  it("leaves the reservation standing when phase 2 fails, and converges the retry", async () => {
    const email = address();
    const base = container();
    const broken = withInitializeAccount(base, () =>
      Promise.reject(new Error("Network connection lost.")),
    );
    const failed = await caught(() =>
      registerWithPassword({ container: broken, input: { email, password } }),
    );
    expect(failed).not.toBeNull();

    const reserved = (
      await mappingRowsFor<{
        status: string;
        candidate_user_id: string | null;
      }>(email, "status, candidate_user_id")
    )[0];
    // No compensation runs for a phase-2 failure: the reservation is what a
    // `resume-signup` drives forward, and the TTL sweep is what reclaims it.
    expect(reserved?.status).toBe("reserved");

    // A fresh attempt mints a whole new operation, so it cannot adopt the
    // reservation — it collapses onto the same answer a genuine duplicate gets,
    // and leaves the stalled saga's candidate untouched.
    const retried = await caught(() =>
      registerWithPassword({
        container: container(),
        input: { email, password },
      }),
    );
    expect(isConflictError(retried)).toBe(true);
    expect((retried as { code: string }).code).toBe("EMAIL_ALREADY_REGISTERED");
    const still = (
      await mappingRowsFor<{ candidate_user_id: string | null }>(
        email,
        "candidate_user_id",
      )
    )[0];
    expect(reserved?.candidate_user_id).not.toBeNull();
    expect(still?.candidate_user_id).toBe(reserved?.candidate_user_id);
  });

  it("replays phase 2 idempotently, and refuses a replay with another payload", async () => {
    const email = address();
    const base = container();
    const seen: InitializeAccountArgs[] = [];
    // Calls through and *then* throws: the shape of a response lost on the way
    // back, which is the case the four-branch predicate in `initializeAccount`
    // exists for.
    const lossy = withInitializeAccount(base, async (real, args) => {
      seen.push(args);
      await real.initializeAccount(args);
      throw new Error("Network connection lost.");
    });
    await caught(() =>
      registerWithPassword({ container: lossy, input: { email, password } }),
    );
    const args = seen[0];
    if (args === undefined) throw new Error("phase 2 never ran");

    const stub = base.userDataStubFactory(args.userId);
    const replay = await stub.initializeAccount(args);
    expect(replay.ok).toBe(true);
    const counts = await inUserDataOf(args.userId, (sql) => ({
      accounts: sql.exec("SELECT status FROM account").toArray().length,
      operations: sql.exec("SELECT operation_id FROM operations").toArray()
        .length,
      settings: sql
        .exec("SELECT trash_retention_days FROM user_settings")
        .toArray().length,
    }));
    expect(counts).toEqual({ accounts: 1, operations: 1, settings: 1 });

    const mismatched = await stub.initializeAccount({
      ...args,
      payloadDigest: `${args.payloadDigest}0`,
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.ok === false && mismatched.error.code).toBe(
      "OPERATION_PAYLOAD_MISMATCH",
    );

    // A different operation aimed at the same Durable Object is refused
    // outright — that is the branch that keeps a stranger from writing into
    // somebody else's DO once its `userId` has leaked.
    const stranger = await stub.initializeAccount({
      ...args,
      operationId: `${args.operationId}-other`,
    });
    expect(stranger.ok).toBe(false);
    expect(stranger.ok === false && stranger.error.code).toBe(
      "OPERATION_NOT_RECOGNISED",
    );
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

    // Filtered on the hmac, like `mappingRowsFor` and for the same reason: two
    // addresses in one test can legitimately share a bucket (there are 256 of
    // them), and `kind` alone would then count both requests' rows twice over.
    // A `send-mail` key is `send-mail:{kind}:{hmac}:{window}`, so the hmac is
    // what narrows it to *this* address without pinning the window the run fell
    // into.
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
              `SELECT kind, operation_key FROM jobs
                WHERE kind = 'send-mail' AND instr(operation_key, ?) = 1`,
              `send-mail:email:${locator.hmac}:`,
            )
            .toArray(),
      ) as Promise<{ kind: string; operation_key: string }[]>;
    };

    await askForResetLink(registeredAddress);
    await askForResetLink(unknownAddress);

    // Identical row count and identical shape: the difference between the two
    // is confined to what the send resolves later, so the enqueue itself is not
    // an enumeration oracle.
    const registeredRows = await jobsFor(registeredAddress);
    const unknownRows = await jobsFor(unknownAddress);
    expect(registeredRows).toHaveLength(1);
    expect(unknownRows).toHaveLength(1);
    // Witness that the filter above narrowed to two *different* rows. Without
    // it, a query that answered the same single row twice — which is what a
    // shared bucket plus an over-broad predicate produces — would satisfy the
    // two counts and assert nothing about the unregistered address at all.
    expect(registeredRows[0]?.operation_key).not.toBe(
      unknownRows[0]?.operation_key,
    );
  });

  it("sends the link to the address the signup itself sealed", async () => {
    const email = address();
    await registerWithPassword({
      container: container(),
      input: { email, password: "correct horse battery staple" },
    });
    await askForResetLink(email);

    // Nothing seeded the ciphertext: the recipient is recovered from what the
    // signup wrote, which closes the loop the write side used to leave open
    // (ADR-030 → ADR-036). An unregistered address in the same run produces the
    // same job row and no recipient at all.
    expect(await deliverDueMail(email)).toEqual([email]);

    const unknown = address();
    await askForResetLink(unknown);
    expect(await deliverDueMail(unknown)).toEqual([]);
  });
});
