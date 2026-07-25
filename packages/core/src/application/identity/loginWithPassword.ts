import { User } from "@repo/core/domain/identity/entity";
import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  Email,
  type PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { ValidationError } from "../errors";
import type { ServiceArgs } from "../types";

export type LoginWithPasswordInput = {
  email: string;
  password: string;
};

export type LoginWithPasswordOutput = {
  userId: string;
};

const invalidCredentials = (): ValidationError =>
  new ValidationError("INVALID_CREDENTIALS", "Invalid email or password");

/**
 * A throwaway hash, in the `PasswordHasher` adapter's stored encoding, of a
 * password nobody holds. It exists so a login that finds no password
 * account still pays for one key derivation — see `burnVerificationTime`.
 *
 * Produced with the adapter's production parameters (PBKDF2-HMAC-SHA256,
 * 210,000 iterations), so its self-described cost matches the real one.
 */
const DUMMY_PASSWORD_HASH =
  "pbkdf2-sha256$210000$IPASLZIobSfU953IiVIH2Q==$A5VaiykJ+nWoXmrMVC5ewoE8QX2KddgLOL5qBfMJSRA=" as PasswordHash;

/**
 * Runs one verification whose outcome is discarded, so the "no such
 * account" and "wrong password" paths take comparable time.
 *
 * The result cannot matter and neither can a failure: a hasher that cannot
 * parse {@link DUMMY_PASSWORD_HASH} (an algorithm swap that leaves this
 * constant stale) must not turn an unknown address into a 500. That
 * degrades the equalisation back to today's behaviour rather than breaking
 * login, which is why this is the one place a throw is swallowed.
 */
async function burnVerificationTime(
  hasher: PasswordHasher,
  plainPassword: PlainPassword,
): Promise<void> {
  try {
    await hasher.verify(plainPassword, DUMMY_PASSWORD_HASH);
  } catch {
    // deliberately ignored
  }
}

/**
 * Authenticates a password account (S-AC-03 / UC-identity-003).
 *
 * Every way this can fail — malformed email, password outside the length
 * bounds, unknown address, an SSO-only account, a wrong password —
 * produces the identical `ValidationError("INVALID_CREDENTIALS")`. That
 * uniformity is the feature: any difference in code, message or field
 * would let an attacker probe which addresses are registered and how.
 * Note this includes value-object failures, which everywhere else in the
 * codebase surface as `BusinessRuleError`.
 *
 * Response time is levelled the same way: an address with no password
 * account still pays for one key derivation
 * ({@link burnVerificationTime}), so the wall clock does not disclose what
 * the answer refuses to. The malformed-input path is exempt — it never
 * reaches storage and reveals only what the caller already typed.
 */
export async function loginWithPassword({
  container,
  input,
}: ServiceArgs<LoginWithPasswordInput>): Promise<LoginWithPasswordOutput> {
  let email: Email;
  let plainPassword: PlainPassword;
  try {
    email = Email.create(input.email);
    plainPassword = PlainPassword.create(input.password);
  } catch {
    throw invalidCredentials();
  }

  const found = await container.unitOfWorkProvider.run(({ userRepository }) =>
    userRepository.findByEmail(email),
  );
  if (!found) {
    await burnVerificationTime(container.passwordHasher, plainPassword);
    throw invalidCredentials();
  }

  const user = found.entity;
  if (!User.isPasswordUser(user)) {
    await burnVerificationTime(container.passwordHasher, plainPassword);
    throw invalidCredentials();
  }

  const matches = await container.passwordHasher.verify(
    plainPassword,
    user.passwordHash,
  );
  if (!matches) throw invalidCredentials();

  return { userId: user.id };
}
