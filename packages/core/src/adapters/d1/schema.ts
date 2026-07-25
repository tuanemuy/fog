import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Timestamps are ms-precision so they round-trip with `Date` and align
// with outbox `occurred_at` and the UUIDv7 monotonic ordering encoded
// in `id`. All timestamps come from the application `Clock` (no SQL
// defaults) so fakes can freeze time deterministically. The same rule
// applies to `trash_retention_days`: the default (30) is supplied by
// `TrashRetentionDays.default()`, not by the DB.
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    // Stored already normalised (trim + lowercase) by `Email.create`, so
    // `users_email_uq` enforces uniqueness on the normalised form and
    // `findByEmail` is a plain equality lookup.
    email: text("email").notNull(),
    authMethod: text("auth_method").notNull(),
    passwordHash: text("password_hash"),
    ssoProvider: text("sso_provider"),
    ssoProviderSubject: text("sso_provider_subject"),
    trashRetentionDays: integer("trash_retention_days").notNull(),
    version: integer("version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Mirrors the `PasswordUser | SsoUser` discriminated union: the
    // discriminator decides which nullable columns must be present, so a
    // row like "password account carrying an SSO subject" cannot exist
    // even if a future writer bypasses the domain.
    check(
      "users_auth_method_sum",
      sql`(auth_method = 'password' AND password_hash IS NOT NULL AND sso_provider IS NULL AND sso_provider_subject IS NULL) OR (auth_method = 'sso' AND password_hash IS NULL AND sso_provider IS NOT NULL AND sso_provider_subject IS NOT NULL)`,
    ),
    // The three checks below are implied by the sum constraint's
    // disjuncts but kept separate so a violation names the invariant it
    // broke rather than reporting the whole union as failed.
    check("users_auth_method_valid", sql`auth_method IN ('password','sso')`),
    check(
      "users_sso_provider_valid",
      sql`sso_provider IS NULL OR sso_provider IN ('google','apple')`,
    ),
    check(
      "users_sso_subject_nonempty",
      sql`sso_provider_subject IS NULL OR length(sso_provider_subject) > 0`,
    ),
    // Independent of the sum constraint — nothing above bounds the
    // retention window, so without this the `TrashRetentionDays`
    // invariant would hold only in application code.
    check("users_trash_retention_positive", sql`trash_retention_days >= 1`),
    uniqueIndex("users_email_uq").on(table.email),
    // Partial: `PasswordUser` rows leave both SSO columns NULL and must
    // not collide with each other.
    uniqueIndex("users_sso_identity_uq")
      .on(table.ssoProvider, table.ssoProviderSubject)
      .where(sql`sso_provider IS NOT NULL`),
  ],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    failedAt: integer("failed_at", { mode: "timestamp_ms" }),
    // Claim/lease pair so multiple relay workers cannot dispatch the
    // same row. `claimed_at` is stamped at claim time; a row is
    // re-claimable once `claimed_at <= now - leaseMs` (covers crashed
    // workers without an explicit unclaim step). `claimed_by` is a
    // free-form worker id (from `IdGenerator`) — used only for
    // diagnostics.
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    claimedBy: text("claimed_by"),
  },
  (table) => [
    // Pending = not yet processed, not quarantined, due for next
    // attempt. The relay worker queries this slice each tick;
    // quarantined rows (`failed_at IS NOT NULL`) are deliberately
    // excluded from the index so a poison row no longer pollutes the
    // hot path. The claim/lease filter is checked on top of this slice
    // at claim time.
    index("idx_outbox_pending")
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`processed_at IS NULL AND failed_at IS NULL`),
  ],
);

export const processedEvents = sqliteTable("processed_events", {
  id: text("id").primaryKey(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull(),
});

// Name of the CHECK constraint on `_occ_guard.n > 0`. Exported so the
// adapter's OCC-violation detector can match against it without
// re-declaring the literal — schema and detector must stay in lockstep.
export const OCC_GUARD_CHECK_NAME = "occ_guard_positive";

// `_occ_guard` is the abort lever for OCC failures inside a
// `db.batch()`.
//
// D1 batches are atomic but treat `UPDATE ... WHERE version = ?`
// matching zero rows as a normal success — the batch commits the rest.
// To turn an OCC mismatch into a batch-wide rollback, each OCC-guarded
// write is followed by:
//
//     INSERT INTO _occ_guard (n)
//       SELECT changes() WHERE changes() = 0;
//
// `changes()` returns the row count touched by the immediately
// preceding statement. When that is > 0 the SELECT yields no rows
// and the INSERT is a no-op; when it is 0 the SELECT yields a single
// `n = 0` row, the CHECK constraint (`n > 0`) fails, the batch aborts,
// and the OCC handler in `PendingBatch` translates the driver error
// into a `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. Because the
// success path never inserts, the table stays empty between batches
// without an explicit DELETE.
export const occGuard = sqliteTable(
  "_occ_guard",
  {
    n: integer("n").notNull(),
  },
  (table) => [check(OCC_GUARD_CHECK_NAME, sql`${table.n} > 0`)],
);
