/**
 * The full enumeration of Alarm job kinds, together with the DO class that
 * owns each one and how each one re-arms itself.
 *
 * This module has **no imports**: it is read by the composition roots, by the
 * DO-side execution modules and by unit tests alike, and a value import from
 * an execution module into a composition root is exactly the cycle that makes
 * the top-level Worker evaluate module-scope randomness, which workerd rejects.
 *
 * `spec/database/index.md` (the `kind` full-count table) is the source of
 * truth. Adding a `kind` means editing that table, the four-category table in
 * `CLAUDE.md` and this module in the same change.
 */

export const JOB_KINDS = [
  "purge-trash",
  "reindex",
  "migrate-bulk",
  "finalize-withdrawal",
  "sweep-orphan-mapping",
  "resume-link",
  "send-mail",
  "resume-signup",
  "resume-credential-change",
  "sweep-reservations",
  "sweep-reset-tokens",
  "rotate-encryption",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export type DoClass = "userData" | "identityDirectory";

/** A = clock-driven, B = backlog-driven, C = one-shot. A and B re-arm. */
export type RearmClass = "A" | "B" | "C";

/**
 * Declared with `as const satisfies` rather than a type annotation on purpose:
 * an annotation widens every value to `DoClass`, and the conditional type that
 * derives the per-DO handler-registry keys (`JobKindOf`) would then admit every
 * kind on both sides.
 */
export const JOB_OWNER = {
  "purge-trash": "userData",
  reindex: "userData",
  "migrate-bulk": "userData",
  "finalize-withdrawal": "userData",
  "sweep-orphan-mapping": "userData",
  "resume-link": "userData",
  "send-mail": "identityDirectory",
  "resume-signup": "identityDirectory",
  "resume-credential-change": "identityDirectory",
  "sweep-reservations": "identityDirectory",
  "sweep-reset-tokens": "identityDirectory",
  "rotate-encryption": "identityDirectory",
} as const satisfies Readonly<Record<JobKind, DoClass>>;

export const JOB_REARM = {
  "purge-trash": "A",
  reindex: "C",
  "migrate-bulk": "C",
  "finalize-withdrawal": "C",
  "sweep-orphan-mapping": "B",
  "resume-link": "C",
  "send-mail": "C",
  "resume-signup": "C",
  "resume-credential-change": "C",
  "sweep-reservations": "A",
  "sweep-reset-tokens": "A",
  "rotate-encryption": "B",
} as const satisfies Readonly<Record<JobKind, RearmClass>>;

/**
 * The kinds whose `done` row `enqueueJob` may revive (convergence rule 3).
 * Equivalently: the kinds that re-arm themselves on completion, so a `done`
 * row means "no backlog right now", not "this request was already served".
 */
export const REARMING_KINDS: readonly JobKind[] = [
  "purge-trash",
  "sweep-orphan-mapping",
  "sweep-reservations",
  "sweep-reset-tokens",
  "rotate-encryption",
];
