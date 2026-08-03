import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import {
  type Keyring,
  requireKeyring,
  type StateSecrets,
} from "@repo/core/application/di/secrets";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import type { MailSender } from "@repo/core/domain/identity/ports/mailSender";
import type { Email } from "@repo/core/domain/identity/valueObject";
import {
  RESET_REQUEST_WINDOW_MS,
  RESET_TOKEN_TTL_MS,
} from "@repo/core/lib/jobBudgets";
import { describe, expect, it } from "vitest";
import { inIdentityDirectory } from "../../__tests__/doHarness";
import { assertNoForbiddenValue } from "../../__tests__/forbiddenValues";
import {
  encryptCanonical,
  sealCanonical,
} from "../../identityDirectory/canonicalCipher";
import * as facade from "../../identityDirectory/facade";
import {
  deriveProviderIdempotencyKey,
  sendMailOperationKey,
} from "../../identityDirectory/resetRequestKeys";
import { mintResetTokenMaterial } from "../../identityDirectory/resetTokenCrypto";
import { createIdentityDirectoryUnitOfWorkProvider } from "../../identityDirectory/unitOfWork";
import { runMigrationGate } from "../../schema/gate";
import {
  IDENTITY_DIRECTORY_CODE_VERSION,
  IDENTITY_DIRECTORY_STEPS,
} from "../../schema/identityDirectory";
import { IDENTITY_DIRECTORY_JOB_HANDLERS } from "../registry";
import { runDueJobs } from "../runner";
import type { JobRow } from "../table";

/**
 * `request-password-reset` → job row → alarm → `done`, across the whole path.
 *
 * The load-bearing assertion is the **comparison between the four cases**:
 * registered, unregistered, SSO-only and throttled must produce the identical
 * number of job rows, the identical alarm consequence and the identical
 * response. Anything that differs between them is an enumeration oracle — a way
 * for an unauthenticated caller to learn whether an address is on file — and
 * asserting each case in isolation would never catch one.
 */

const NOW = 1_800_000_000_000;
const WINDOW_OF_NOW = Math.floor(NOW / RESET_REQUEST_WINDOW_MS);
/** The first instant of the window after `NOW`. */
const NEXT_WINDOW = (WINDOW_OF_NOW + 1) * RESET_REQUEST_WINDOW_MS;
const BUCKET = "dir:g1:b0007";

const MAIL_KEYRING: Keyring = requireKeyring(
  JSON.stringify([
    { generation: 1, key: "test-mail-encryption-key-0123456789" },
  ]),
  "IDENTITY_MAIL_ENCRYPTION_KEY",
  { requireBucketCount: false },
);
const RESET_KEYRING: Keyring = requireKeyring(
  JSON.stringify([{ generation: 1, key: "test-reset-token-key-0123456789ab" }]),
  "IDENTITY_RESET_TOKEN_KEY",
  { requireBucketCount: false },
);
const SECRETS: StateSecrets = {
  mailEncryptionKeyring: MAIL_KEYRING,
  resetTokenKeyring: RESET_KEYRING,
};

const idGenerator: IdGenerator = {
  next: () => "generated-id",
  validate: () => true,
};

type Sent = { to: string; resetToken: string; idempotencyKey: string };

function recordingMailSender(): { sender: MailSender; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    sender: {
      sendPasswordResetMail(
        to: Email,
        resetToken: string,
        idempotencyKey: string,
      ): Promise<void> {
        sent.push({ to, resetToken, idempotencyKey });
        return Promise.resolve();
      },
    },
  };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string, meta?: Record<string, unknown>) => {
    lines.push(message);
    if (meta !== undefined) lines.push(JSON.stringify(meta));
  };
  return { lines, logger: { info: push, warn: push, error: push } };
}

type Io = {
  sql: SqlStorage;
  ctx: DurableObjectState;
  sent: Sent[];
  lines: string[];
  request: (kind: "email" | "sso", hmac: string, now?: number) => Promise<void>;
  /** Signup's own two phases, so the row is the one `reserve` actually writes. */
  register: (args: {
    hmac: string;
    credentialId: string;
    canonical: string;
    passwordVerifier: string;
  }) => Promise<void>;
  drain: (now?: number) => Promise<void>;
};

let seq = 0;

function harness<T>(fn: (io: Io) => Promise<T> | T): Promise<T> {
  seq += 1;
  return inIdentityDirectory(`${BUCKET}-${seq}`, async ({ ctx, sql }) => {
    runMigrationGate(
      ctx,
      IDENTITY_DIRECTORY_STEPS,
      IDENTITY_DIRECTORY_CODE_VERSION,
      BUCKET,
    );
    const { sender, sent } = recordingMailSender();
    const { logger, lines } = recordingLogger();
    const uow = createIdentityDirectoryUnitOfWorkProvider(ctx, {
      now: () => new Date(NOW),
    });
    return fn({
      sql,
      ctx,
      sent,
      lines,
      // Mirrors the RPC entry: the token and the provider key are derived
      // outside the transaction and arrive as values, so the suite exercises
      // the same composition the DO class does rather than a shortcut only the
      // test can take.
      request: async (kind, hmac, now = NOW) => {
        const material = await mintResetTokenMaterial(RESET_KEYRING);
        const providerIdempotencyKey = await deriveProviderIdempotencyKey(
          sendMailOperationKey(kind, hmac, now),
        );
        facade.requestPasswordReset(
          { uow },
          kind,
          hmac,
          now,
          material,
          providerIdempotencyKey,
        );
      },
      register: async (args) => {
        const sealed = await sealCanonical(MAIL_KEYRING, args.canonical, {
          kind: "email",
          credentialId: args.credentialId,
        });
        facade.reserveCredential(
          { uow },
          {
            kind: "email",
            hmac: args.hmac,
            generation: 1,
            credentialId: args.credentialId,
            canonical: args.canonical,
            candidateUserId: "user-1",
            operationId: "op-1",
            callerToken: "caller-1",
            // Far enough out that the `sweep-reservations` row this enqueues is
            // never due inside a case.
            reservedUntil: NOW + 24 * 60 * 60 * 1000,
            isCoordinator: false,
            passwordVerifier: args.passwordVerifier,
          },
          sealed,
          NOW,
        );
        facade.activateReservation(
          { uow },
          "email",
          args.hmac,
          "op-1",
          "user-1",
          "caller-1",
        );
      },
      drain: (now = NOW) =>
        runDueJobs(
          {
            ctx,
            sql,
            now,
            ownerToken: "owner-1",
            logger,
            idGenerator,
            mailSender: sender,
            appUrl: "http://localhost:8787",
            secrets: SECRETS,
          },
          IDENTITY_DIRECTORY_JOB_HANDLERS,
          now,
        ),
    });
  }) as Promise<T>;
}

async function insertMapping(
  sql: SqlStorage,
  args: {
    kind: "email" | "sso";
    hmac: string;
    credentialId: string;
    canonical: string | null;
    passwordVerifier: string | null;
  },
): Promise<void> {
  const sealed =
    args.canonical === null
      ? null
      : await encryptCanonical(MAIL_KEYRING, args.canonical, {
          kind: args.kind,
          credentialId: args.credentialId,
          generation: 1,
        });
  sql.exec(
    `INSERT INTO credential_mappings (
       credential_id, kind, hmac, generation, user_id, status,
       password_verifier, pending_verifier, change_state, change_origin,
       credential_version, encrypted_canonical, encryption_generation,
       encryption_nonce, failed_attempts, next_attempt_allowed_at,
       last_reset_requested_at, operation_id, candidate_user_id, reserved_until,
       saga_committed, locators, coordinator_locator, caller_token,
       created_at, updated_at
     ) VALUES (?, ?, ?, 1, 'user-1', 'active', ?, NULL, NULL, NULL, 0, ?, ?, ?,
               0, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0, 0)`,
    args.credentialId,
    args.kind,
    args.hmac,
    args.passwordVerifier,
    sealed?.ciphertext ?? null,
    sealed === null ? null : 1,
    sealed?.nonce ?? null,
  );
}

function jobs(sql: SqlStorage): JobRow[] {
  return sql
    .exec<JobRow>("SELECT * FROM jobs ORDER BY operation_key")
    .toArray();
}

/**
 * Every request also arms the bucket's `sweep-reset-tokens` row, which is what
 * eventually removes the rows this path writes. It is a per-bucket constant, so
 * assertions about *this request* read the mail rows.
 */
function mailJobs(sql: SqlStorage): JobRow[] {
  return jobs(sql).filter((row) => row.kind === "send-mail");
}

function tokenHashes(sql: SqlStorage): string[] {
  return sql
    .exec<{ token_hash: string }>(
      "SELECT token_hash FROM password_reset_tokens ORDER BY token_hash",
    )
    .toArray()
    .map((row) => row.token_hash);
}

function tokenCount(sql: SqlStorage): number {
  return (
    sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM password_reset_tokens")
      .toArray()[0]?.n ?? 0
  );
}

describe("send-mail", () => {
  it("delivers a link for a registered address and settles the row done", async () => {
    const result = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "aa".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "aa".repeat(32));
      const beforeRun = mailJobs(sql);
      await drain();
      return { beforeRun, after: mailJobs(sql), sent };
    });
    expect(result.beforeRun).toHaveLength(1);
    expect(result.beforeRun[0]?.status).toBe("pending");
    expect(result.after[0]?.status).toBe("done");
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]?.to).toBe("user@example.com");
    // `{routingGeneration}.{bucketIndex}.{hmac}` — routable back to this bucket
    // without the routing secret, which is not distributed to the state Worker.
    expect(result.sent[0]?.resetToken).toMatch(/^1\.7\.[0-9a-f]{64}$/);
    // `SHA-256` of the `operationKey`, so a redelivery presents the same key —
    // and the request window is part of the pre-image, so the *next* window's
    // request is not deduplicated against this one on the provider's side.
    expect(result.sent[0]?.idempotencyKey).toBe(
      await deriveProviderIdempotencyKey(
        `send-mail:email:${"aa".repeat(32)}:${WINDOW_OF_NOW}`,
      ),
    );
    // And the pre-image itself never leaves: the canonical address's
    // full-length HMAC is what a mapping row is keyed by.
    expect(result.sent[0]?.idempotencyKey).not.toContain("aa".repeat(32));
    expect(result.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the raw link out of the job row", async () => {
    const result = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "bb".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "bb".repeat(32));
      const payload = mailJobs(sql)[0]?.payload ?? "";
      await drain();
      return { payload, token: sent[0]?.resetToken ?? "" };
    });
    // The payload holds the request and nothing derived from it; the link is
    // built at send time under a key the database never holds, so a dump alone
    // reproduces nothing.
    expect(result.payload).not.toContain(result.token);
    expect(JSON.parse(result.payload)).toEqual({
      kind: "email",
      hmac: "bb".repeat(32),
    });
  });

  it("treats the four request cases identically up to the response", async () => {
    const registered = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "11".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "11".repeat(32));
      const rows = jobs(sql);
      await drain();
      return { rows, tokens: tokenCount(sql), sent: sent.length };
    });

    const unregistered = await harness(
      async ({ sql, request, drain, sent }) => {
        await request("email", "22".repeat(32));
        const rows = jobs(sql);
        await drain();
        return { rows, tokens: tokenCount(sql), sent: sent.length };
      },
    );

    const ssoOnly = await harness(async ({ sql, request, drain, sent }) => {
      // The address reservation an SSO signup leaves behind: it has a stored
      // canonical, so "no recipient" cannot be the test — the decision is the
      // absence of a `password_verifier`.
      await insertMapping(sql, {
        kind: "email",
        hmac: "33".repeat(32),
        credentialId: "cred-1",
        canonical: "sso-user@example.com",
        passwordVerifier: null,
      });
      await request("email", "33".repeat(32));
      const rows = jobs(sql);
      await drain();
      return { rows, tokens: tokenCount(sql), sent: sent.length };
    });

    const throttled = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "44".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      sql.exec(
        "UPDATE credential_mappings SET last_reset_requested_at = ?",
        NOW,
      );
      await request("email", "44".repeat(32));
      const rows = jobs(sql);
      await drain();
      return { rows, tokens: tokenCount(sql), sent: sent.length };
    });

    const shapeOf = (result: { rows: JobRow[] }) => ({
      // Both rows, in both kinds: the sweep is enqueued whatever the case
      // decides, so its presence cannot answer "is this address registered?".
      kinds: result.rows.map((row) => row.kind),
      status: result.rows[0]?.status,
      // Identical `next_run_at` means the alarm the RPC arms is identical too.
      nextRunAt: result.rows[0]?.next_run_at,
      sweepNextRunAt: result.rows[1]?.next_run_at,
    });

    const expected = {
      kinds: ["send-mail", "sweep-reset-tokens"],
      status: "pending",
      nextRunAt: NOW,
      sweepNextRunAt: NOW + RESET_TOKEN_TTL_MS,
    };
    expect(shapeOf(registered)).toEqual(expected);
    expect(shapeOf(unregistered)).toEqual(expected);
    expect(shapeOf(ssoOnly)).toEqual(expected);
    expect(shapeOf(throttled)).toEqual(expected);

    // Only the outcome differs, and only after the response has gone out.
    expect(registered.sent).toBe(1);
    expect(unregistered.sent).toBe(0);
    expect(ssoOnly.sent).toBe(0);
    expect(throttled.sent).toBe(0);
    // Throttling withholds the token row too: issuing and deleting the previous
    // unused row are the same operation, so a caller outside the window cannot
    // destroy a victim's live link without generating a single mail.
    expect(registered.tokens).toBe(1);
    expect(throttled.tokens).toBe(0);
  });

  it("collapses a burst on one address onto a single row and one wake-up", async () => {
    const result = await harness(async ({ sql, request, drain }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "55".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      for (let i = 0; i < 5; i += 1) await request("email", "55".repeat(32));
      const before = mailJobs(sql);
      await drain();
      // `send-mail` is not a re-arming kind, so the surviving `done` row is
      // what refuses the repeat — reviving it would make wake-ups scale with
      // request count.
      for (let i = 0; i < 5; i += 1) await request("email", "55".repeat(32));
      return { before, after: mailJobs(sql) };
    });
    expect(result.before).toHaveLength(1);
    expect(result.after).toHaveLength(1);
    expect(result.after[0]?.status).toBe("done");
  });

  it("delivers again in the next window, and never issues a token it will not send", async () => {
    const result = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "99".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "99".repeat(32));
      await drain();
      const first = {
        tokens: tokenHashes(sql),
        sent: sent.map((entry) => entry.resetToken),
      };

      // A legitimate second request, once the window has turned. The failure
      // this guards against: the throttle opens, a fresh token replaces the live
      // one, and the enqueue collides with the finished row — so the user's
      // working link is destroyed and no replacement is ever sent.
      await request("email", "99".repeat(32), NEXT_WINDOW);
      await drain(NEXT_WINDOW);
      return {
        first,
        second: {
          tokens: tokenHashes(sql),
          sent: sent.map((entry) => entry.resetToken),
        },
        rows: mailJobs(sql),
      };
    });

    expect(result.first.sent).toHaveLength(1);
    expect(result.first.tokens).toHaveLength(1);
    // A new window is a new row, so the send actually happens.
    expect(result.rows).toHaveLength(2);
    expect(result.second.sent).toHaveLength(2);
    // The replacement token is what the second mail carries: issuing and
    // delivering share one window, so a token is never minted for a mail that
    // will not go out — nor a mail sent for a token that no longer exists.
    expect(result.second.tokens).toHaveLength(1);
    expect(result.second.tokens).not.toEqual(result.first.tokens);
    expect(result.second.sent[1]).not.toBe(result.second.sent[0]);
  });

  it("withholds a token when the same window is asked twice", async () => {
    const result = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "ab".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "ab".repeat(32));
      await drain();
      const issued = tokenHashes(sql);
      // Half a window later: refused, and — the point of the assertion — the
      // live link the first mail carried is still the one on file.
      await request(
        "email",
        "ab".repeat(32),
        NOW + RESET_REQUEST_WINDOW_MS / 2,
      );
      await drain(NOW + RESET_REQUEST_WINDOW_MS / 2);
      return { issued, still: tokenHashes(sql), sent: sent.length };
    });
    expect(result.sent).toBe(1);
    expect(result.still).toEqual(result.issued);
  });

  it("is idempotent when the same row is redelivered", async () => {
    const sent = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "66".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "66".repeat(32));
      await drain();
      // Stands in for a DO reset between the send and the row settling.
      sql.exec(
        "UPDATE jobs SET status='pending', next_run_at=? WHERE kind='send-mail'",
        NOW,
      );
      await drain();
      return sent;
    });
    expect(sent).toHaveLength(2);
    // Both deliveries carry the same provider key, which is what collapses them
    // on the provider's side.
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
  });

  it("sends nothing once the token has expired, and still settles done", async () => {
    const result = await harness(async ({ sql, request, drain, sent }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "77".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "77".repeat(32));
      sql.exec("UPDATE password_reset_tokens SET expires_at = ?", NOW - 1);
      await drain();
      return { sent: sent.length, status: mailJobs(sql)[0]?.status };
    });
    expect(result.sent).toBe(0);
    expect(result.status).toBe("done");
  });

  /**
   * The enqueue point, not the handler. `directoryJobs.integration.test.ts`
   * calls `sweepResetTokens` directly, so a handler that is correct but never
   * enqueued passes there — and `password_reset_tokens` then grows without bound
   * in a bucket many users share.
   */
  it("arms the sweep that eventually clears the rows this path writes", async () => {
    const result = await harness(async ({ sql, request, drain }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "ce".repeat(32),
        credentialId: "cred-1",
        canonical: "user@example.com",
        passwordVerifier: "verifier",
      });
      await request("email", "ce".repeat(32));
      await drain();
      // Consumption stamps `used_at` and leaves a reusable `change_auth_token`
      // behind. `issue` only ever deletes *unused* rows, so without the sweep
      // nothing removes this one — ever.
      sql.exec(
        "UPDATE password_reset_tokens SET used_at = ?, change_auth_token = 'change-auth'",
        NOW,
      );
      const armed = jobs(sql).filter(
        (row) => row.kind === "sweep-reset-tokens",
      );
      const before = tokenCount(sql);
      await drain(NOW + RESET_TOKEN_TTL_MS + 1);
      return { armed, before, after: tokenCount(sql) };
    });
    expect(result.armed).toHaveLength(1);
    expect(result.armed[0]?.next_run_at).toBe(NOW + RESET_TOKEN_TTL_MS);
    expect(result.before).toBe(1);
    expect(result.after).toBe(0);
  });

  /**
   * The invariant `RESET_REQUEST_WINDOW_MS` states — an eligible request always
   * lands on an `operationKey` no earlier request could have created — has to
   * hold across the instant the mapping row itself appears. Requests made while
   * the address was unregistered leave a `send-mail` row and no row to stamp, so
   * a mapping that started eligible could walk straight into a key that is
   * already `done`: `send-mail` is not a re-arming kind, the enqueue converges
   * silently, and the token would exist with no job left to deliver it.
   */
  it("does not let a mapping born mid-window spend a send-mail key an earlier request already used", async () => {
    const result = await harness(
      async ({ sql, request, register, drain, sent }) => {
        const hmac = "de".repeat(32);
        // Unregistered: a row is written all the same — that uniformity is what
        // stops the four cases being told apart — and it runs to `done` having
        // sent nothing.
        await request("email", hmac);
        await drain();
        const spent = mailJobs(sql);

        // The address is signed up for inside that same window.
        await register({
          hmac,
          credentialId: "cred-1",
          canonical: "user@example.com",
          passwordVerifier: "verifier",
        });

        await request("email", hmac);
        const sameWindow = { rows: mailJobs(sql), tokens: tokenCount(sql) };
        await drain();

        // Positive control: the next window's key is unused, so the request
        // that becomes eligible there is delivered.
        await request("email", hmac, NEXT_WINDOW);
        await drain(NEXT_WINDOW);
        return {
          spent,
          sameWindow,
          sent: sent.length,
          rows: mailJobs(sql),
          tokens: tokenCount(sql),
        };
      },
    );
    expect(result.spent).toHaveLength(1);
    expect(result.spent[0]?.status).toBe("done");
    // The load-bearing pair: the only row for this window is the finished one,
    // and no token was minted that it could not carry.
    expect(result.sameWindow.rows).toHaveLength(1);
    expect(result.sameWindow.rows[0]?.status).toBe("done");
    expect(result.sameWindow.tokens).toBe(0);
    expect(result.rows).toHaveLength(2);
    expect(result.sent).toBe(1);
    expect(result.tokens).toBe(1);
  });

  it("keeps PII out of the log when there is no recipient to resolve", async () => {
    const lines = await harness(async ({ sql, request, drain, lines }) => {
      await insertMapping(sql, {
        kind: "email",
        hmac: "88".repeat(32),
        credentialId: "cred-1",
        canonical: null,
        passwordVerifier: "verifier",
      });
      await request("email", "88".repeat(32));
      await drain();
      return lines;
    });
    expect(lines.length).toBeGreaterThan(0);
    assertNoForbiddenValue(lines);
  });
});
