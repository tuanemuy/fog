import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { User } from "../entity";

/**
 * The per-user settings half of what used to be `UserRepository`.
 *
 * **No `findById`.** `userId` was consumed when the Durable Object stub was
 * selected, and one instance holds exactly one user's settings — a lookup
 * taking an id would suggest another user's row is reachable from here, and
 * none is.
 *
 * **`insert` / `save` do not write `User.credentials`, and no transition on
 * this aggregate can.** `find` projects the set from `CredentialLocatorStore`
 * (`spec/domains/identity.md`: "`User.credentials` is this store's
 * projection"), so writing it from here would put two things in charge of one
 * fact. Linking and unlinking therefore go through
 * `CredentialLocatorStore.record` / `deleteByCredentialId`, and `save` is only
 * ever about `trashRetentionDays` and the OCC `version`. `User` deliberately
 * offers no `addCredential` / `removeCredential`: a call that bumped `version`
 * and left the set untouched would make the procedure look like it worked
 * (ADR-070). The "at least one way in" check that an unlink owes is
 * `User.loginCredentialCount`.
 *
 * Follows the `TransactionalRepository` OCC convention (insert for first-time
 * persistence, `find` as the issuer of the `ExpectedVersion<User>` token,
 * `save` consuming it) without extending it: the base also mandates `delete`,
 * and settings rows are never deleted.
 *
 * The backing table is single-row, so `save`'s conditional update carries no
 * `id` predicate — `version` alone conditions it.
 *
 * Errors:
 * - stale token on `save` → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
 * - a stored row that cannot be rehydrated → `SystemError(DataIntegrityError)`
 * - driver failure → `SystemError(DatabaseError)`
 * - not yet initialised is not an error; it is `null`
 */
export interface UserSettingsRepository {
  insert(user: User): void;
  save(user: User, expectedVersion: ExpectedVersion<User>): void;
  find(): Versioned<User> | null;
}
