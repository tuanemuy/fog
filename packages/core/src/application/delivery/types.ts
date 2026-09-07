import type { SerializedErrorBase } from "@repo/core/lib/error";

/**
 * `jobs.kind` for the User Data DO — six kinds, and that is the whole of
 * it. The roster of every `jobs.kind` and `event.type` lives in exactly
 * one place, `spec/async/index.md`; adding one means answering which of
 * the three classification rules it matched and adding a row there.
 */
export type UserDataJobKind =
  | "purge-trash"
  | "reindex"
  | "migrate-bulk"
  | "finalize-withdrawal"
  | "sweep-orphan-mapping"
  | "resume-link";

/** `jobs.kind` for the Identity Directory DO — five kinds, all of them. */
export type IdentityDirectoryJobKind =
  | "resume-signup"
  | "resume-credential-change"
  | "sweep-reservations"
  | "sweep-reset-tokens"
  | "rotate-encryption";

export type JobKind = UserDataJobKind | IdentityDirectoryJobKind;

export const USER_DATA_JOB_KINDS = [
  "purge-trash",
  "reindex",
  "migrate-bulk",
  "finalize-withdrawal",
  "sweep-orphan-mapping",
  "resume-link",
] as const satisfies readonly UserDataJobKind[];

export const IDENTITY_DIRECTORY_JOB_KINDS = [
  "resume-signup",
  "resume-credential-change",
  "sweep-reservations",
  "sweep-reset-tokens",
  "rotate-encryption",
] as const satisfies readonly IdentityDirectoryJobKind[];

/**
 * Per-kind declaration of the two convergence properties the runner
 * needs. Both are declared for all eleven kinds rather than listed as a
 * set of exceptions: a partial dictionary would let a newly added kind
 * fall through silently instead of failing to type-check.
 *
 * `rearmsOnCompletion` — the job re-reads its own driver (a `min(...)`
 * timestamp, or whether work remains) in its completion transaction and
 * goes back to `pending` while work remains. Without it a dormant DO
 * never wakes again after one full run.
 *
 * `revivesFromDone` — convergence rule (3): re-submitting `enqueueJob`
 * against a `done` row brings it back to `pending`. The other six kinds
 * treat a `done` row as "this unit of work finished", so a re-submission
 * is a duplicate request and writes nothing.
 *
 * The two coincide for every kind today (spec derives the second from
 * the first), and a unit test asserts that they do; they are separate
 * fields because the runner consults them at different points.
 */
export type JobKindPolicy = Readonly<{
  rearmsOnCompletion: boolean;
  revivesFromDone: boolean;
}>;

export const JOB_KIND_POLICY: Readonly<Record<JobKind, JobKindPolicy>> = {
  "purge-trash": { rearmsOnCompletion: true, revivesFromDone: true },
  reindex: { rearmsOnCompletion: false, revivesFromDone: false },
  "migrate-bulk": { rearmsOnCompletion: false, revivesFromDone: false },
  "finalize-withdrawal": { rearmsOnCompletion: false, revivesFromDone: false },
  "sweep-orphan-mapping": { rearmsOnCompletion: true, revivesFromDone: true },
  "resume-link": { rearmsOnCompletion: false, revivesFromDone: false },
  "resume-signup": { rearmsOnCompletion: false, revivesFromDone: false },
  "resume-credential-change": {
    rearmsOnCompletion: false,
    revivesFromDone: false,
  },
  "sweep-reservations": { rearmsOnCompletion: true, revivesFromDone: true },
  "sweep-reset-tokens": { rearmsOnCompletion: true, revivesFromDone: true },
  "rotate-encryption": { rearmsOnCompletion: true, revivesFromDone: true },
};

/**
 * Response of the send-materials RPC — two branches, and that is the
 * whole of it (`spec/async/index.md`).
 *
 * `nothing-to-send` carries **no reason field**. Unregistered / SSO-only
 * / consumed / expired / superseded all collapse to the same empty
 * branch: the response reaches consumer logs and the DLQ, so a reason
 * would leak whether an address is registered.
 *
 * `providerIdempotencyKey` is derived by the DO from `event.id` with a
 * key that never leaves the DO; the consumer neither derives it nor
 * holds the key. Neither the recipient nor the raw token is persisted
 * anywhere — they exist only in this response and in the request to the
 * provider.
 */
export type SendMailMaterials =
  | Readonly<{
      kind: "send";
      to: string;
      resetToken: string;
      providerIdempotencyKey: string;
    }>
  | Readonly<{ kind: "nothing-to-send" }>;

export type SerializedRpcError = SerializedErrorBase & { kind: string };

/**
 * Value envelope for the request Worker ↔ Durable Object boundary.
 *
 * Errors never cross that boundary as thrown custom classes — RPC does
 * not preserve the structural serialization contract, and `instanceof`
 * fails across module graphs anyway. The DO's RPC entry catches and
 * returns `toSerialized()`; the calling adapter additionally translates
 * platform failures raised by the stub call itself, which never enter
 * the envelope at all.
 *
 * It stays in the application layer — unlike the Queue message, which is
 * an adapter type — because the envelope is the repository-wide rule for
 * carrying an error across a process boundary and names no platform type
 * of its own; the boundary above is only where it is used first.
 */
export type RpcEnvelope<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: SerializedRpcError }>;

/** One quarantined outbox row as returned by `list-quarantined-events`. */
export type QuarantinedEventSummary = Readonly<{
  eventId: string;
  type: string;
  attempt: number;
  createdAt: number;
  completedAt: number;
  terminalReason: string | null;
}>;

/**
 * Continuation cursor for `list-quarantined-events`, ordered by
 * `completed_at` ascending (the only order `outbox_completed_idx`
 * resolves without a sort). The keyset shape is settled: an offset would
 * skip rows during the case this listing exists for, since operators
 * page through a mass quarantine while re-drives are removing rows from
 * under them.
 *
 * **The order is total only because every quarantined row has a
 * `completed_at`, and that is held by the statements, not by the column
 * type — the column is nullable.** Two statements are the whole of it.
 * A row reaches `quarantined` only through `finalizeRow`
 * (`rowRunner.ts`), whose single assignment list writes `status` and
 * `completed_at` together, so no row can enter this set without one; and
 * the only statement that writes `completed_at = NULL` back is the
 * operator re-drive, which sets `status = 'pending'` in that same
 * statement and therefore takes the row out of the set as it clears the
 * column. The invariant therefore holds, and `listQuarantinedEvents`
 * (`durableObjectBase.ts`) still reads the column through `?? 0`: the
 * column is nullable, so the read has to be total, and what keeps the
 * `NULL` branch unreachable is those two statements rather than the type.
 * **Limit: that `?? 0` is a total read, not a recovery.** A third
 * statement writing the status column would break the invariant and
 * nothing here would notice — a `NULL` falls outside the keyset predicate
 * entirely rather than sorting at either end, since every comparison
 * against it is UNKNOWN, and one in the last row of a page collapses the
 * cursor to `0`, which hands the next page the whole set from the start.
 */
export type QuarantinedEventCursor = Readonly<{
  completedAt: number;
  eventId: string;
}>;

export type ListQuarantinedEventsResult = Readonly<{
  rows: readonly QuarantinedEventSummary[];
  nextCursor: QuarantinedEventCursor | null;
}>;
