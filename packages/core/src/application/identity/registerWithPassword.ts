import { User } from "@repo/core/domain/identity/entity";
import { Email, PlainPassword } from "@repo/core/domain/identity/valueObject";
import { ConflictError, isConflictError } from "../errors";
import type { ServiceArgs } from "../types";

export type RegisterWithPasswordInput = {
  email: string;
  password: string;
};

export type RegisterWithPasswordOutput = {
  userId: string;
};

function emailAlreadyRegistered(cause?: unknown): ConflictError {
  return new ConflictError(
    "EMAIL_ALREADY_REGISTERED",
    "That email address is already registered",
    cause,
  );
}

/**
 * Registers a password account.
 *
 * An already-registered address is rejected outright rather than linked
 * to the existing account, whatever its auth method — silently merging
 * identities is how account-takeover bugs start.
 *
 * The hash is computed before the unit of work opens: key derivation is
 * deliberately slow, and holding a transaction across it would pin a
 * connection for the duration.
 */
export async function registerWithPassword({
  container,
  input,
}: ServiceArgs<RegisterWithPasswordInput>): Promise<RegisterWithPasswordOutput> {
  const now = container.clock.now();
  const id = container.idGenerator.next();
  const email = Email.create(input.email);
  const plainPassword = PlainPassword.create(input.password);

  const passwordHash = await container.passwordHasher.hash(plainPassword);

  try {
    const user = User.registerWithPassword({ id, email, passwordHash }, now);

    await container.unitOfWorkProvider.run(async ({ userRepository }) => {
      const existing = await userRepository.findByEmail(email);
      if (existing) throw emailAlreadyRegistered();
      await userRepository.insert(user);
    });

    return { userId: user.id };
  } catch (error) {
    // The `findByEmail` check above loses to a concurrent registration of
    // the same address; the loser only finds out when the unit of work
    // flushes and `users_email_uq` fires. Reading that as
    // EMAIL_ALREADY_REGISTERED gives the racing caller the same answer as
    // the pre-check would have.
    //
    // Safe only because of what this unit of work writes: one `users`
    // insert. The inserted user is a `PasswordUser`, so both SSO columns
    // are NULL and the partial index `users_sso_identity_uq` cannot match;
    // `users.id` is a UUIDv7, so the primary key does not realistically
    // collide.
    // Add a write with another unique constraint to this unit of work and
    // this translation has to go.
    if (isConflictError(error) && error.code === "UNIQUE_VIOLATION") {
      throw emailAlreadyRegistered(error);
    }
    throw error;
  }
}
