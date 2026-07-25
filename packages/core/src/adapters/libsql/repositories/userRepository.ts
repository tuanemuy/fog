import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import { isRehydrationError } from "@repo/core/domain/error";
import { User } from "@repo/core/domain/identity/entity";
import type { UserRepository } from "@repo/core/domain/identity/ports/userRepository";
import type { Email, UserId } from "@repo/core/domain/identity/valueObject";
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import type { PendingBatch } from "../pendingBatch";
import { users } from "../schema";
import { mapDbError } from "./helpers";

type UserRow = typeof users.$inferSelect;

/**
 * libSQL `UserRepository`. Reads run immediately; writes register
 * closures on the `PendingBatch` for the surrounding UoW to flush.
 * OCC is enforced via the `ExpectedVersion<User>` token both lookups
 * (`findById` / `findByEmail`) return — the `toVersioned` helper is this
 * adapter's only construction site for it.
 *
 * As on D1, the deferred flush means a unique-constraint violation on
 * `insert` cannot be caught here; `EMAIL_ALREADY_REGISTERED` is
 * translated by the `registerWithPassword` usecase.
 */
export class LibsqlUserRepository implements UserRepository {
  constructor(
    private readonly db: Database,
    private readonly pending: PendingBatch,
    private readonly idGenerator: IdGenerator,
  ) {}

  private toUser(row: UserRow): User {
    if (!this.idGenerator.validate(row.id)) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Stored user has malformed id: ${row.id}`,
      );
    }
    try {
      return User.reconstruct(row);
    } catch (error) {
      if (isRehydrationError(error)) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "Stored user violates invariants",
          error,
        );
      }
      throw error;
    }
  }

  private toVersioned(row: UserRow): Versioned<User> {
    return {
      entity: this.toUser(row),
      expectedVersion: row.version as ExpectedVersion<User>,
    };
  }

  findById(id: UserId): Promise<Versioned<User> | null> {
    return mapDbError("Failed to find user", async () => {
      const rows = await this.db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = rows[0];
      return row ? this.toVersioned(row) : null;
    });
  }

  // `Email` is normalised at construction, and the column stores the
  // normalised form, so plain equality rides `users_email_uq`.
  findByEmail(email: Email): Promise<Versioned<User> | null> {
    return mapDbError("Failed to find user by email", async () => {
      const rows = await this.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = rows[0];
      return row ? this.toVersioned(row) : null;
    });
  }

  async insert(user: User): Promise<void> {
    this.pending.add((tx) => tx.insert(users).values(toInsertValues(user)));
  }

  async save(
    user: User,
    expectedVersion: ExpectedVersion<User>,
  ): Promise<void> {
    const userId = user.id;
    this.pending.addOcc(
      (tx) =>
        tx
          .update(users)
          .set(toUpdateValues(user))
          .where(
            and(
              eq(users.id, user.id),
              eq(users.version, expectedVersion as number),
            ),
          ),
      () => {
        throw new ConflictError(
          "OPTIMISTIC_LOCK_FAILURE",
          `Optimistic lock failure while saving user ${userId}: expected version ${expectedVersion}`,
        );
      },
    );
  }
}

// The sum-type columns are written from the discriminated union so a
// `PasswordUser` always nulls the SSO pair and vice versa — the shape the
// `users_auth_method_sum` CHECK expects.
function authColumns(user: User) {
  return user.authMethod === "password"
    ? {
        authMethod: "password",
        passwordHash: user.passwordHash,
        ssoProvider: null,
        ssoProviderSubject: null,
      }
    : {
        authMethod: "sso",
        passwordHash: null,
        ssoProvider: user.provider,
        ssoProviderSubject: user.providerSubject,
      };
}

function toInsertValues(user: User): typeof users.$inferInsert {
  return {
    id: user.id,
    email: user.email,
    ...authColumns(user),
    trashRetentionDays: user.trashRetentionDays,
    version: user.version,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toUpdateValues(user: User) {
  return {
    email: user.email,
    ...authColumns(user),
    trashRetentionDays: user.trashRetentionDays,
    version: user.version,
    updatedAt: user.updatedAt,
  };
}
