import type { SqlStorage } from "@cloudflare/workers-types";
import { isConflictError } from "@repo/core/application/errors";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { inIdentityDirectory } from "../../__tests__/doHarness";
import { runMigrationGate } from "../../schema/gate";
import {
  IDENTITY_DIRECTORY_CODE_VERSION,
  IDENTITY_DIRECTORY_STEPS,
} from "../../schema/identityDirectory";
import { createCredentialMappingStore } from "../mappingOperations";

/**
 * `activate` as a **compare-and-set**.
 *
 * A predicate that matched nothing must not report success: signup's phase 3
 * would then run to completion over a reservation that was swept, or that
 * belonged to another operation, leaving an account nobody can ever sign in to
 * and no signal anywhere saying why.
 *
 * The binding is `callerToken` as well as `operationId`, for the reason
 * `recordCredentialLocator` states about itself: `operationId` is a value the
 * design permits in unauthenticated logs, so a write conditioned on knowing it
 * alone turns a logged value into a capability.
 */

const KIND = "email" as const;
const HMAC = "c3".repeat(32);
const OPERATION = "operation-1";
const CALLER = "caller-token-secret";
const CANDIDATE = "user-candidate";

const NOW = 1_800_000_000_000;

let seq = 0;

function seeded<T>(
  fn: (io: {
    sql: SqlStorage;
    store: ReturnType<typeof createCredentialMappingStore>;
  }) => T,
) {
  seq += 1;
  const name = `dir:g1:b9${seq}`;
  return inIdentityDirectory(name, ({ ctx, sql }) => {
    runMigrationGate(
      ctx,
      IDENTITY_DIRECTORY_STEPS,
      IDENTITY_DIRECTORY_CODE_VERSION,
      name,
    );
    sql.exec(
      `INSERT INTO credential_mappings (
         credential_id, kind, hmac, generation, user_id, status,
         password_verifier, pending_verifier, change_state, change_origin,
         credential_version, encrypted_canonical, encryption_generation,
         encryption_nonce, failed_attempts, next_attempt_allowed_at,
         last_reset_requested_at, operation_id, candidate_user_id,
         reserved_until, saga_committed, locators, coordinator_locator,
         caller_token, created_at, updated_at
       ) VALUES ('cred-1', ?, ?, 1, NULL, 'reserved', 'verifier', NULL, NULL,
                 NULL, 0, 'ct', 1, 'nonce', 0, NULL, NULL, ?, ?, 0, NULL, NULL,
                 NULL, ?, 0, 0)`,
      KIND,
      HMAC,
      OPERATION,
      CANDIDATE,
      CALLER,
    );
    return ctx.storage.transactionSync(() =>
      fn({ sql, store: createCredentialMappingStore(sql, () => NOW) }),
    );
  });
}

function status(sql: SqlStorage): { status: string; user_id: string | null } {
  const row = sql
    .exec<{ status: string; user_id: string | null }>(
      "SELECT status, user_id FROM credential_mappings",
    )
    .toArray()[0];
  if (row === undefined) throw new Error("no mapping row");
  return row;
}

function caught(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe("credential mapping activate", () => {
  it("promotes the reservation it was given", async () => {
    const result = await seeded(({ sql, store }) => {
      store.activate(KIND, HMAC, OPERATION, CANDIDATE, CALLER);
      return status(sql);
    });
    expect(result.status).toBe("active");
    expect(result.user_id).toBe(CANDIDATE);
  });

  it("is idempotent when the same operation runs the phase twice", async () => {
    const result = await seeded(({ sql, store }) => {
      store.activate(KIND, HMAC, OPERATION, CANDIDATE, CALLER);
      // `resume-signup` drives a stalled saga forward, so phase 3 is re-run as
      // a matter of course; the second call must not look like a conflict.
      store.activate(KIND, HMAC, OPERATION, CANDIDATE, CALLER);
      return status(sql);
    });
    expect(result.status).toBe("active");
  });

  it("refuses when the reservation is gone", async () => {
    const error = await seeded(({ sql, store }) => {
      sql.exec("DELETE FROM credential_mappings");
      // Exactly what `sweep-reservations` leaves behind.
      return caught(() =>
        store.activate(KIND, HMAC, OPERATION, CANDIDATE, CALLER),
      );
    });
    expect(isConflictError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "RESERVATION_NOT_ACTIVATABLE",
    );
  });

  it("refuses a different operation", async () => {
    const result = await seeded(({ sql, store }) => {
      const error = caught(() =>
        store.activate(KIND, HMAC, "operation-2", CANDIDATE, CALLER),
      );
      return { error, row: status(sql) };
    });
    expect(isConflictError(result.error)).toBe(true);
    expect(result.row.status).toBe("reserved");
  });

  it("refuses a caller that does not hold the reservation's token", async () => {
    const result = await seeded(({ sql, store }) => {
      const error = caught(() =>
        store.activate(KIND, HMAC, OPERATION, CANDIDATE, "not-the-token"),
      );
      return { error, row: status(sql) };
    });
    // Knowing the `operationId` is not enough, and that is the whole point:
    // it is a value the design permits in unauthenticated logs.
    expect(isConflictError(result.error)).toBe(true);
    expect(result.row.status).toBe("reserved");
  });

  it("refuses to promote the reservation onto a different user", async () => {
    const result = await seeded(({ sql, store }) => {
      const error = caught(() =>
        store.activate(KIND, HMAC, OPERATION, "attacker-user", CALLER),
      );
      return { error, row: status(sql) };
    });
    expect(isConflictError(result.error)).toBe(true);
    expect(result.row.user_id).toBeNull();
  });
});

describe("credential mapping promote", () => {
  it("refuses when no change has reached 'advanced'", async () => {
    const error = await seeded(({ store }) =>
      caught(() => store.promote("cred-1" as CredentialId, OPERATION)),
    );
    // Silently matching nothing would report a verifier replacement that never
    // happened, leaving the two sides of a password change permanently apart.
    expect(isConflictError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(
      "CREDENTIAL_CHANGE_NOT_ADVANCED",
    );
  });
});

/**
 * The same shape as `activate` and `promote`.
 *
 * `change_state IS NULL` genuinely misses whenever another change is in flight,
 * and this write is the instant the old material stops verifying — so a silent
 * no-op leaves the caller a saga that believes a fail-closed window opened when
 * it did not.
 */
describe("credential mapping beginChange", () => {
  it("starts a change on a credential with none in flight", async () => {
    const row = await seeded(({ sql, store }) => {
      store.beginChange(
        "cred-1" as CredentialId,
        "new-verifier",
        "reset",
        "op-2",
      );
      return sql
        .exec<{ change_state: string | null; pending_verifier: string | null }>(
          "SELECT change_state, pending_verifier FROM credential_mappings",
        )
        .toArray()[0];
    });
    expect(row?.change_state).toBe("pending");
    expect(row?.pending_verifier).toBe("new-verifier");
  });

  it("refuses a second change while one is already in flight", async () => {
    const result = await seeded(({ sql, store }) => {
      store.beginChange("cred-1" as CredentialId, "first", "reset", "op-2");
      const error = caught(() =>
        store.beginChange(
          "cred-1" as CredentialId,
          "second",
          "password-change",
          "op-3",
        ),
      );
      return {
        error,
        row: sql
          .exec<{ pending_verifier: string | null }>(
            "SELECT pending_verifier FROM credential_mappings",
          )
          .toArray()[0],
      };
    });
    expect(isConflictError(result.error)).toBe(true);
    expect((result.error as { code: string }).code).toBe(
      "CREDENTIAL_CHANGE_NOT_STARTABLE",
    );
    // The first change is untouched — the refusal is not a partial write.
    expect(result.row?.pending_verifier).toBe("first");
  });

  it("refuses a credential that is not there at all, with the same answer", async () => {
    const error = await seeded(({ store }) =>
      caught(() =>
        store.beginChange("cred-absent" as CredentialId, "v", "reset", "op-2"),
      ),
    );
    expect((error as { code: string }).code).toBe(
      "CREDENTIAL_CHANGE_NOT_STARTABLE",
    );
  });
});
