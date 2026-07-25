import { User } from "@repo/core/domain/identity/entity";
import { Email, PlainPassword } from "@repo/core/domain/identity/valueObject";
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
 * Timing is not equalised — a miss skips the hash comparison and answers
 * sooner. Closing that channel needs a dummy verify against a fixed hash;
 * out of scope here, and recorded as a known limitation.
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
  if (!found) throw invalidCredentials();

  const user = found.entity;
  if (!User.isPasswordUser(user)) throw invalidCredentials();

  const matches = await container.passwordHasher.verify(
    plainPassword,
    user.passwordHash,
  );
  if (!matches) throw invalidCredentials();

  return { userId: user.id };
}
