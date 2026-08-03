import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import type { MailSender } from "@repo/core/domain/identity/ports/mailSender";
import { describe, expect, it } from "vitest";
import { inIdentityDirectory } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import {
  IDENTITY_DIRECTORY_CODE_VERSION,
  IDENTITY_DIRECTORY_STEPS,
} from "../../schema/identityDirectory";
import { resumeSignup } from "../handlers/resumeSignup";
import { sweepReservations } from "../handlers/sweepReservations";
import { sweepResetTokens } from "../handlers/sweepResetTokens";
import type { IdentityDirectoryJobContext, JobOutcome } from "../registry";
import type { JobRow } from "../table";

/** The three DO-local Identity Directory jobs. */

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const idGenerator: IdGenerator = {
  next: () => "generated-id",
  validate: () => true,
};

const silentMailSender: MailSender = {
  sendPasswordResetMail: () => Promise.resolve(),
};

/**
 * None of the three handlers below logs on a path this file exercises, so the
 * logger is a dependency rather than an observable. A recording one whose lines
 * no assertion reads is worse than none — it looks like the suite is checking
 * observability when it is not.
 */
function silentLogger(): Logger {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop };
}

let seq = 0;

type Io = {
  sql: SqlStorage;
  ctx: DurableObjectState;
  context: (now?: number) => IdentityDirectoryJobContext;
};

function harness<T>(fn: (io: Io) => Promise<T> | T): Promise<T> {
  seq += 1;
  const name = `dir-jobs-${seq}`;
  return inIdentityDirectory(name, ({ ctx, sql }) => {
    runMigrationGate(
      ctx,
      IDENTITY_DIRECTORY_STEPS,
      IDENTITY_DIRECTORY_CODE_VERSION,
      "dir:g1:b0001",
    );
    const logger = silentLogger();
    return fn({
      sql,
      ctx,
      context: (now = NOW) => ({
        ctx,
        sql,
        now,
        ownerToken: "owner-1",
        logger,
        idGenerator,
        mailSender: silentMailSender,
        appUrl: "http://localhost:8787",
        secrets: null,
      }),
    });
  }) as Promise<T>;
}

const EMPTY_ROW = { operation_key: "k", payload: "{}" } as JobRow;

function addToken(sql: SqlStorage, tokenId: string, expiresAt: number): void {
  sql.exec(
    `INSERT INTO password_reset_tokens (
       token_id, token_hash, credential_id, expires_at, used_at,
       change_auth_token, consumed_by_operation_id, token_key_generation,
       created_at
     ) VALUES (?, ?, 'cred-1', ?, NULL, NULL, NULL, 1, 0)`,
    tokenId,
    `hash-of-${tokenId}`,
    expiresAt,
  );
}

function addReservation(
  sql: SqlStorage,
  args: {
    hmac: string;
    status: "reserved" | "active";
    reservedUntil: number;
    sagaCommitted?: number;
    operationId?: string;
    coordinator?: boolean;
  },
): void {
  sql.exec(
    `INSERT INTO credential_mappings (
       credential_id, kind, hmac, generation, user_id, status,
       password_verifier, pending_verifier, change_state, change_origin,
       credential_version, encrypted_canonical, encryption_generation,
       encryption_nonce, failed_attempts, next_attempt_allowed_at,
       last_reset_requested_at, operation_id, candidate_user_id, reserved_until,
       saga_committed, locators, coordinator_locator, caller_token,
       created_at, updated_at
     ) VALUES (?, 'email', ?, 1, NULL, ?, NULL, NULL, NULL, NULL, 0, NULL,
               NULL, NULL, 0, NULL, NULL, ?, 'user-1', ?, ?, '[]', ?, 'tok',
               0, 0)`,
    `cred-${args.hmac}`,
    args.hmac,
    args.status,
    args.operationId ?? "op-1",
    args.reservedUntil,
    args.sagaCommitted ?? null,
    args.coordinator === true ? null : "dir:g1:b0002",
  );
}

function tokenIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ token_id: string }>(
      "SELECT token_id FROM password_reset_tokens ORDER BY token_id",
    )
    .toArray()
    .map((row) => row.token_id);
}

function mappingHmacs(sql: SqlStorage): string[] {
  return sql
    .exec<{ hmac: string }>(
      "SELECT hmac FROM credential_mappings ORDER BY hmac",
    )
    .toArray()
    .map((row) => row.hmac);
}

describe("sweep-reset-tokens", () => {
  it("removes expired tokens and re-arms at the next expiry", async () => {
    const result = await harness(async ({ sql, context }) => {
      addToken(sql, "expired", NOW - MINUTE);
      addToken(sql, "live", NOW + 5 * MINUTE);
      const outcome = await sweepResetTokens(context(), EMPTY_ROW);
      return { outcome, tokens: tokenIds(sql) };
    });
    expect(result.tokens).toEqual(["live"]);
    // Class (A): the drive signal is `min(expires_at)` over *all* rows, so a
    // bucket nobody touches still wakes to clear the token it is holding.
    expect(result.outcome).toEqual({
      kind: "rearm",
      nextRunAt: NOW + 5 * MINUTE,
    });
  });

  it("settles to done only when no token is left", async () => {
    const outcome = await harness(async ({ sql, context }) => {
      addToken(sql, "expired", NOW - MINUTE);
      return sweepResetTokens(context(), EMPTY_ROW);
    });
    expect(outcome).toEqual({ kind: "done" });
  });
});

describe("sweep-reservations", () => {
  it("removes reservations whose TTL ran out", async () => {
    const result = await harness(async ({ sql, context }) => {
      addReservation(sql, {
        hmac: "expired",
        status: "reserved",
        reservedUntil: NOW - MINUTE,
      });
      addReservation(sql, {
        hmac: "live",
        status: "reserved",
        reservedUntil: NOW + MINUTE,
      });
      const outcome = await sweepReservations(context(), EMPTY_ROW);
      return { outcome, mappings: mappingHmacs(sql) };
    });
    expect(result.mappings).toEqual(["live"]);
    expect(result.outcome).toEqual({ kind: "rearm", nextRunAt: NOW + MINUTE });
  });

  it("never touches an activated mapping", async () => {
    const result = await harness(async ({ sql, context }) => {
      addReservation(sql, {
        hmac: "promoted",
        status: "active",
        reservedUntil: NOW - MINUTE,
      });
      const outcome = await sweepReservations(context(), EMPTY_ROW);
      return { outcome, mappings: mappingHmacs(sql) };
    });
    expect(result.mappings).toEqual(["promoted"]);
    expect(result.outcome).toEqual({ kind: "done" });
  });

  it("leaves a committed saga's reservation alone, and stops waking for it", async () => {
    const result = await harness(async ({ sql, context }) => {
      addReservation(sql, {
        hmac: "committed",
        status: "reserved",
        reservedUntil: NOW - MINUTE,
        sagaCommitted: 1,
      });
      const outcome = await sweepReservations(context(), EMPTY_ROW);
      return { outcome, mappings: mappingHmacs(sql) };
    });
    // Excluded from the work predicate: another bucket is already past the
    // point of no return and still relies on this uniqueness claim.
    expect(result.mappings).toEqual(["committed"]);
    // And excluded from the drive signal too. Excluding it from only one of the
    // two would leave the bucket waking forever for a row it may not touch.
    expect(result.outcome).toEqual({ kind: "done" });
  });
});

describe("resume-signup", () => {
  const row = (operationId: string) =>
    ({
      operation_key: `resume-signup:${operationId}`,
      payload: JSON.stringify({ operationId }),
    }) as JobRow;

  it("settles when the coordinator's reservation is gone", async () => {
    const outcome = await harness(({ context }) =>
      resumeSignup(context(), row("op-missing")),
    );
    expect(outcome).toEqual({ kind: "done" });
  });

  it("settles when the saga reached phase 3", async () => {
    const outcome = await harness(async ({ sql, context }) => {
      addReservation(sql, {
        hmac: "h1",
        status: "active",
        reservedUntil: NOW - MINUTE,
        operationId: "op-1",
        coordinator: true,
      });
      return resumeSignup(context(), row("op-1"));
    });
    expect(outcome).toEqual({ kind: "done" });
  });

  it("waits out the TTL rather than declaring a slow saga stalled", async () => {
    const outcome = await harness(async ({ sql, context }) => {
      addReservation(sql, {
        hmac: "h1",
        status: "reserved",
        reservedUntil: NOW + MINUTE,
        operationId: "op-1",
        coordinator: true,
      });
      return resumeSignup(context(), row("op-1"));
    });
    expect(outcome).toEqual({ kind: "rearm", nextRunAt: NOW + MINUTE });
  });

  it("reaches the uniform terminus once the reservation has expired", async () => {
    const result = await harness(async ({ sql, context }) => {
      addReservation(sql, {
        hmac: "h1",
        status: "reserved",
        reservedUntil: NOW - MINUTE,
        operationId: "op-1",
        coordinator: true,
      });
      const outcome: JobOutcome = await resumeSignup(context(), row("op-1"));
      return {
        outcome,
        // The reverse information a rollback will need is still on the row:
        // deleting it here would destroy the evidence before anything reads it.
        locators: sql
          .exec<{ locators: string | null; caller_token: string | null }>(
            "SELECT locators, caller_token FROM credential_mappings",
          )
          .toArray()[0],
      };
    });
    expect(result.outcome).toEqual({
      kind: "terminal",
      reason: "SIGNUP_RESERVATION_EXPIRED",
    });
    expect(result.locators?.locators).toBe("[]");
    expect(result.locators?.caller_token).toBe("tok");
  });

  it("refuses a payload it cannot read instead of retrying it forever", async () => {
    const outcome = await harness(({ context }) =>
      resumeSignup(context(), EMPTY_ROW),
    );
    expect(outcome).toEqual({
      kind: "terminal",
      reason: "RESUME_SIGNUP_PAYLOAD_INVALID",
    });
  });
});
