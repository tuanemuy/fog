import { env, runInDurableObject } from "cloudflare:test";
import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import {
  type Keyring,
  requireKeyring,
  type StateSecrets,
} from "@repo/core/application/di/secrets";
import type { Email } from "@repo/core/domain/identity/valueObject";
import type { RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
import { describe, expect, it } from "vitest";
import { IDENTITY_DIRECTORY_JOB_HANDLERS } from "../../jobs/registry";
import { runDueJobs } from "../../jobs/runner";
import { encryptCanonical } from "../canonicalCipher";
import {
  formatResetToken,
  parseResetToken,
  resetTokenDigest,
} from "../resetTokenCrypto";
import { createResetTokenStore } from "../resetTokenStore";

/**
 * **Issue → the link in the mail → verify**, composed end to end.
 *
 * The three used to be written against three different values — the row stored
 * a hash of `token_id`, the mail carried an HMAC of `token_id`, and
 * `verifyAndConsume` re-hashed whatever it was handed — so the value a user
 * received could never find its row, while the value sitting in the primary key
 * in the clear always could. Nothing failed, because nothing joined them up.
 * This suite is that join: the token it verifies is the string the mail
 * actually carried, parsed out of it and nothing else.
 *
 * It also fixes the property in the opposite direction: submitting `token_id`,
 * the value a database dump hands over, must match no row.
 */

const HMAC = "a1".repeat(32);
const CANONICAL = "reset-user@example.com";
const CREDENTIAL_ID = "cred-reset-1";
const USER_ID = "user-reset-1";

const MAIL_KEYRING: Keyring = requireKeyring(
  env.IDENTITY_MAIL_ENCRYPTION_KEY,
  "IDENTITY_MAIL_ENCRYPTION_KEY",
  { requireBucketCount: false },
);
const RESET_KEYRING: Keyring = requireKeyring(
  env.IDENTITY_RESET_TOKEN_KEY,
  "IDENTITY_RESET_TOKEN_KEY",
  { requireBucketCount: false },
);
const SECRETS: StateSecrets = {
  mailEncryptionKeyring: MAIL_KEYRING,
  resetTokenKeyring: RESET_KEYRING,
};

/**
 * The routing bound `parseResetToken` checks the link's coordinates against.
 * They are unauthenticated input on the consumption side and they address a
 * Durable Object, so parsing them is not enough — only the routing keyring
 * knows a generation's bucket count.
 */
const ROUTING = [{ generation: 1, bucketCount: 1024 }] as const;

type Bucket = {
  requestPasswordReset(
    kind: "email" | "sso",
    hmac: string,
  ): Promise<RpcEnvelope<null>>;
  checkPreviousGeneration(
    kind: "email" | "sso",
    hmac: string,
  ): Promise<RpcEnvelope<boolean>>;
};

let seq = 0;

async function registeredBucket(): Promise<ReturnType<typeof bucketFor>> {
  seq += 1;
  const stub = bucketFor(`dir:g1:b7${seq}`);
  // Any gated entry brings the schema up; the diagnostics deliberately do not.
  await (stub as unknown as Bucket).checkPreviousGeneration("email", HMAC);

  const sealed = await encryptCanonical(MAIL_KEYRING, CANONICAL, {
    kind: "email",
    credentialId: CREDENTIAL_ID,
    generation: 1,
  });
  await runInDurableObject(stub, (_instance, ctx) => {
    (ctx.storage.sql as SqlStorage).exec(
      `INSERT INTO credential_mappings (
         credential_id, kind, hmac, generation, user_id, status,
         password_verifier, pending_verifier, change_state, change_origin,
         credential_version, encrypted_canonical, encryption_generation,
         encryption_nonce, failed_attempts, next_attempt_allowed_at,
         last_reset_requested_at, operation_id, candidate_user_id,
         reserved_until, saga_committed, locators, coordinator_locator,
         caller_token, created_at, updated_at
       ) VALUES (?, 'email', ?, 1, ?, 'active', 'verifier', NULL, NULL, NULL,
                 0, ?, 1, ?, 0, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL,
                 NULL, 0, 0)`,
      CREDENTIAL_ID,
      HMAC,
      USER_ID,
      sealed.ciphertext,
      sealed.nonce,
    );
  });
  return stub;
}

function bucketFor(name: string) {
  const ns = env.IDENTITY_DIRECTORY;
  return ns.get(ns.idFromName(name));
}

/** Runs the bucket's due jobs with a sender the test can read. */
function deliver(stub: ReturnType<typeof bucketFor>): Promise<string[]> {
  const links: string[] = [];
  const now = Date.now();
  return runInDurableObject(stub, (_instance, ctx) =>
    runDueJobs(
      {
        ctx: ctx as DurableObjectState,
        sql: ctx.storage.sql as SqlStorage,
        now,
        ownerToken: "test-owner",
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        idGenerator: { next: () => "generated-id", validate: () => true },
        mailSender: {
          sendPasswordResetMail: (_to: Email, resetToken: string) => {
            links.push(resetToken);
            return Promise.resolve();
          },
        },
        appUrl: "http://localhost:8787",
        secrets: SECRETS,
      },
      IDENTITY_DIRECTORY_JOB_HANDLERS,
      now,
    ),
  ).then(() => links) as Promise<string[]>;
}

type Row = { token_id: string; token_hash: string };

function tokenRow(stub: ReturnType<typeof bucketFor>): Promise<Row> {
  return runInDurableObject(stub, (_instance, ctx) => {
    const row = (ctx.storage.sql as SqlStorage)
      .exec<Row>("SELECT token_id, token_hash FROM password_reset_tokens")
      .toArray()[0];
    if (row === undefined) throw new Error("no token row");
    return row;
  }) as Promise<Row>;
}

function consume(
  stub: ReturnType<typeof bucketFor>,
  tokenHash: string,
): Promise<{ userId: string; changeAuthToken: string } | null> {
  return runInDurableObject(stub, (_instance, ctx) => {
    const sql = ctx.storage.sql as SqlStorage;
    return ctx.storage.transactionSync(() =>
      createResetTokenStore(sql).verifyAndConsume(
        tokenHash,
        new Date(Date.now()),
        "operation-1",
      ),
    );
  }) as Promise<{ userId: string; changeAuthToken: string } | null>;
}

/**
 * What #12's consumption entry will do, and the only shape this suite offers a
 * value in: parse the link, hash its secret half, hand the digest to the
 * synchronous port. Anything unparseable is `null` without a query, which is
 * the same answer an unknown token gets.
 */
async function redeem(
  stub: ReturnType<typeof bucketFor>,
  link: string,
): Promise<{ userId: string; changeAuthToken: string } | null> {
  const parsed = parseResetToken(link, ROUTING);
  if (parsed === null) return null;
  return consume(stub, await resetTokenDigest(parsed.secret));
}

describe("the password reset token", () => {
  it("composes from the mailed link all the way to a consumed row", async () => {
    const stub = await registeredBucket();
    await (stub as unknown as Bucket).requestPasswordReset("email", HMAC);

    const links = await deliver(stub);
    expect(links).toHaveLength(1);

    const parsed = parseResetToken(links[0] as string, ROUTING);
    // The routing coordinates are the bucket's own, so the consumption endpoint
    // can address it back without the routing secret.
    expect(parsed).not.toBeNull();
    expect(parsed?.generation).toBe(1);

    const consumed = await consume(
      stub,
      await resetTokenDigest(parsed?.secret ?? ""),
    );
    expect(consumed?.userId).toBe(USER_ID);
    // The change-auth token is the only binding a reset-initiated credential
    // change can present, and it is minted at consumption rather than at issue.
    expect(consumed?.changeAuthToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses the same link twice", async () => {
    const stub = await registeredBucket();
    await (stub as unknown as Bucket).requestPasswordReset("email", HMAC);
    const parsed = parseResetToken((await deliver(stub))[0] as string, ROUTING);
    const digest = await resetTokenDigest(parsed?.secret ?? "");

    expect(await consume(stub, digest)).not.toBeNull();
    expect(await consume(stub, digest)).toBeNull();
  });

  it("stores nothing a database dump could redeem", async () => {
    const stub = await registeredBucket();
    await (stub as unknown as Bucket).requestPasswordReset("email", HMAC);
    const link = (await deliver(stub))[0] as string;
    const row = await tokenRow(stub);
    const routing = parseResetToken(link, ROUTING) as {
      generation: number;
      bucket: number;
    };

    // Everything the dump hands over, offered back the way a user offers a
    // link. `token_id` is the value that used to work — it is the pre-image the
    // mailed secret is derived from, and it sits in the primary key in the
    // clear — and `token_hash` is the lookup key itself.
    expect(await redeem(stub, row.token_id)).toBeNull();
    expect(
      await redeem(stub, formatResetToken(routing, row.token_id)),
    ).toBeNull();
    expect(
      await redeem(stub, formatResetToken(routing, row.token_hash)),
    ).toBeNull();

    // Not reconstructable in the other direction either: what is stored is a
    // SHA-256, and the HMAC key that produced its pre-image is a state-Worker
    // secret rather than a column.
    expect(link).not.toContain(row.token_id);
    expect(link).not.toContain(row.token_hash);
    expect(await resetTokenDigest(row.token_id)).not.toBe(row.token_hash);

    // The genuine link still works, so the refusals above are not passing
    // because the whole path is broken.
    expect(await redeem(stub, link)).not.toBeNull();
  });

  it("rejects a malformed link the same way as an unknown one", async () => {
    const stub = await registeredBucket();
    await (stub as unknown as Bucket).requestPasswordReset("email", HMAC);
    await deliver(stub);

    expect(parseResetToken("not-a-token", ROUTING)).toBeNull();
    expect(parseResetToken("1.7.short", ROUTING)).toBeNull();
    expect(await consume(stub, "0".repeat(64))).toBeNull();
  });

  /**
   * The coordinates are the one piece of Durable Object addressing that has to
   * come from an unauthenticated URL, so they are bounded here rather than at
   * whatever `idFromName` call site #12 eventually writes. Refusing looks
   * exactly like an unknown token, so the bound adds no observable.
   */
  it("refuses routing coordinates the keyring does not declare", async () => {
    const stub = await registeredBucket();
    await (stub as unknown as Bucket).requestPasswordReset("email", HMAC);
    const link = (await deliver(stub))[0] as string;
    const secret = link.slice(link.lastIndexOf(".") + 1);

    // A generation nobody deployed, and a bucket past that generation's count.
    expect(parseResetToken(`9.0.${secret}`, ROUTING)).toBeNull();
    expect(parseResetToken(`1.1024.${secret}`, ROUTING)).toBeNull();
    expect(parseResetToken(`1.99999999.${secret}`, ROUTING)).toBeNull();
    // Positive control: the same secret under coordinates that do exist parses.
    expect(parseResetToken(`1.1023.${secret}`, ROUTING)).not.toBeNull();
    expect(parseResetToken(link, ROUTING)).not.toBeNull();
  });
});
