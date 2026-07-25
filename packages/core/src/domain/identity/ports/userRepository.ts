import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { User } from "../entity";
import type { Email, UserId } from "../valueObject";

/**
 * Persistence port for the `User` aggregate.
 *
 * Follows the same OCC convention as `TransactionalRepository` — `insert`
 * for first-time persistence, `findById` as the only issuer of the
 * `ExpectedVersion<User>` token, `save` consuming it — but deliberately
 * does **not** extend it: `TransactionalRepository` also mandates
 * `delete(id, expectedVersion)`, and accounts are never deleted. The other
 * identity repositories additionally need `(userId, id)` signatures for
 * tenant scoping, which the base contract cannot express. Every identity
 * port therefore declares its own methods and only shares the convention.
 *
 * `findByEmail` takes the branded `Email`, so the caller has already
 * normalised (trim + lowercase) through `Email.create`; the adapter can
 * compare for equality straight against the `users_email_uq` index.
 *
 * Errors:
 * - `save` with a stale token → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
 * - a stored row that cannot be rehydrated →
 *   `SystemError(DataIntegrityError)`
 * - driver failure → `SystemError(DatabaseError)`
 * - no match on a lookup is not an error; it is `null`
 *
 * Note on unique-constraint translation: the email collision that
 * `insert` races against does not surface here. The unit of work buffers
 * writes and flushes them after the callback returns, so the violation is
 * raised at flush time, outside any `insert` frame. `registerWithPassword`
 * owns that translation instead — see ADR-008.
 */
export interface UserRepository {
  insert(user: User): Promise<void>;
  save(user: User, expectedVersion: ExpectedVersion<User>): Promise<void>;
  findById(id: UserId): Promise<Versioned<User> | null>;
  findByEmail(email: Email): Promise<Versioned<User> | null>;
}
