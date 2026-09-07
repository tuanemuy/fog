import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { User } from "../entity";

/**
 * The per-user settings side of `User`, inside the User Data DO.
 *
 * No `findById`: the DO was selected by `userId`, so the object holds exactly
 * one row and `save` conditions on `version` alone. OCC mismatch is
 * `ConflictError("OPTIMISTIC_LOCK_FAILURE")`; driver failures are
 * `SystemError(DatabaseError)`.
 */
export interface UserSettingsRepository {
  insert(user: User): void;
  save(user: User, expectedVersion: ExpectedVersion<User>): void;
  /** The single account of this Durable Object, or `null` before initialisation. */
  find(): Versioned<User> | null;
}
