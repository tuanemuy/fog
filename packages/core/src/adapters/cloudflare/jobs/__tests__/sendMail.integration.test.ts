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
import { describe, expect, it } from "vitest";
import { inIdentityDirectory } from "../../__tests__/doHarness";
import { assertNoForbiddenValue } from "../../__tests__/forbiddenValues";
import { encryptCanonical } from "../../identityDirectory/canonicalCipher";
import * as facade from "../../identityDirectory/facade";
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
  request: (kind: "email" | "sso", hmac: string, now?: number) => void;
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
    const uow = createIdentityDirectoryUnitOfWorkProvider(
      ctx,
      { now: () => new Date(NOW) },
      1,
    );
    return fn({
      sql,
      ctx,
      sent,
      lines,
      request: (kind, hmac, now = NOW) =>
        facade.requestPasswordReset({ uow }, kind, hmac, now),
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
      request("email", "aa".repeat(32));
      const beforeRun = jobs(sql);
      await drain();
      return { beforeRun, after: jobs(sql), sent };
    });
    expect(result.beforeRun).toHaveLength(1);
    expect(result.beforeRun[0]?.status).toBe("pending");
    expect(result.after[0]?.status).toBe("done");
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]?.to).toBe("user@example.com");
    // `{routingGeneration}.{bucketIndex}.{hmac}` — routable back to this bucket
    // without the routing secret, which is not distributed to the state Worker.
    expect(result.sent[0]?.resetToken).toMatch(/^1\.7\.[0-9a-f]{64}$/);
    // Derived from the `operationKey`, so a redelivery presents the same key.
    expect(result.sent[0]?.idempotencyKey).toBe(
      `send-mail:email:${"aa".repeat(32)}`,
    );
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
      request("email", "bb".repeat(32));
      const payload = jobs(sql)[0]?.payload ?? "";
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
      request("email", "11".repeat(32));
      const rows = jobs(sql);
      await drain();
      return { rows, tokens: tokenCount(sql), sent: sent.length };
    });

    const unregistered = await harness(
      async ({ sql, request, drain, sent }) => {
        request("email", "22".repeat(32));
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
      request("email", "33".repeat(32));
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
      request("email", "44".repeat(32));
      const rows = jobs(sql);
      await drain();
      return { rows, tokens: tokenCount(sql), sent: sent.length };
    });

    const shapeOf = (result: { rows: JobRow[] }) => ({
      rows: result.rows.length,
      kind: result.rows[0]?.kind,
      status: result.rows[0]?.status,
      // Identical `next_run_at` means the alarm the RPC arms is identical too.
      nextRunAt: result.rows[0]?.next_run_at,
    });

    const expected = {
      rows: 1,
      kind: "send-mail",
      status: "pending",
      nextRunAt: NOW,
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
      for (let i = 0; i < 5; i += 1) request("email", "55".repeat(32));
      const before = jobs(sql);
      await drain();
      // `send-mail` is not a re-arming kind, so the surviving `done` row is
      // what refuses the repeat — reviving it would make wake-ups scale with
      // request count.
      for (let i = 0; i < 5; i += 1) request("email", "55".repeat(32));
      return { before, after: jobs(sql) };
    });
    expect(result.before).toHaveLength(1);
    expect(result.after).toHaveLength(1);
    expect(result.after[0]?.status).toBe("done");
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
      request("email", "66".repeat(32));
      await drain();
      // Stands in for a DO reset between the send and the row settling.
      sql.exec("UPDATE jobs SET status='pending', next_run_at=?", NOW);
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
      request("email", "77".repeat(32));
      sql.exec("UPDATE password_reset_tokens SET expires_at = ?", NOW - 1);
      await drain();
      return { sent: sent.length, status: jobs(sql)[0]?.status };
    });
    expect(result.sent).toBe(0);
    expect(result.status).toBe("done");
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
      request("email", "88".repeat(32));
      await drain();
      return lines;
    });
    expect(lines.length).toBeGreaterThan(0);
    assertNoForbiddenValue(lines);
  });
});
