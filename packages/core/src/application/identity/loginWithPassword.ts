import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  Email,
  type PasswordHash,
  PlainPassword,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { ValidationError } from "../errors";
import type { Logger } from "../ports/logger";
import type { ServiceArgs } from "../types";

export type LoginWithPasswordInput = {
  email: string;
  password: string;
};

export type LoginWithPasswordOutput = {
  userId: string;
  sessionEpoch: number;
};

const invalidCredentials = (): ValidationError =>
  new ValidationError("INVALID_CREDENTIALS", "Invalid email or password");
const DUMMY_AUTHORITY_USER_ID = UserId.create(
  "00000000-0000-7000-8000-000000000000",
);
const DUMMY_LOOKUP_EMAIL = Email.create(
  "login-equalization.invalid@example.com",
);

/**
 * The work factor {@link DUMMY_PASSWORD_HASH} declares.
 *
 * `PasswordHasher.verify` reads the cost out of the value it is handed, so
 * this number — not the salt, not the digest — is what makes the burn cost
 * what a real verification costs. Equalisation therefore only holds while
 * it equals the shipped hasher's work factor, and the shipped hasher pins
 * itself to it: `DEFAULT_PBKDF2_ITERATIONS` is declared as `typeof` this
 * constant, so raising one without the other stops compiling.
 */
export const DUMMY_PASSWORD_HASH_ITERATIONS = 210_000;

/**
 * A throwaway hash, in the `PasswordHasher` adapter's stored encoding, of a
 * password nobody holds. It exists so a login that finds no password
 * account still pays for one key derivation — see `burnVerificationTime`.
 *
 * Only the declared cost has to be current; the salt and digest are
 * arbitrary bytes, since no password is ever meant to match them.
 */
const DUMMY_PASSWORD_HASH =
  `pbkdf2-sha256$${DUMMY_PASSWORD_HASH_ITERATIONS}$IPASLZIobSfU953IiVIH2Q==$A5VaiykJ+nWoXmrMVC5ewoE8QX2KddgLOL5qBfMJSRA=` as PasswordHash;

// Latch for the warning below. The fact it reports — this deployment's
// hasher cannot read the dummy — is a property of the process, not of a
// request, while the branch that reports it is reachable by unauthenticated
// traffic (unknown addresses, SSO accounts). Logging per attempt would let
// that traffic inflate the volume of the only signal that the timing
// equalisation has stopped working, so it is emitted once per isolate.
let dummyHashUnreadableReported = false;

/**
 * Runs one verification whose outcome is discarded, so the "no such
 * account" and "wrong password" paths take comparable time.
 *
 * The result cannot matter and neither can a failure: a hasher that cannot
 * parse {@link DUMMY_PASSWORD_HASH} (an algorithm swap that leaves this
 * constant stale) must not turn an unknown address into a 500. That
 * degrades the equalisation back to today's behaviour rather than breaking
 * login, which is why this is the one place a throw is swallowed — and why
 * it is logged: the request is unaffected, so the warning is the only
 * signal that the mitigation has stopped working. The latch above holds it
 * to once per isolate, which is the granularity of the fact.
 *
 * Only the failure's type is logged, never the value: the `PasswordHasher`
 * contract forbids putting a `PlainPassword` in what it throws, and
 * projecting to a name rather than passing the object through keeps that
 * promise from being the only thing standing between a swapped-in hasher
 * and a plaintext password in the logs.
 */
async function burnVerificationTime(
  hasher: PasswordHasher,
  plainPassword: PlainPassword,
  logger: Logger,
): Promise<void> {
  try {
    await hasher.verify(plainPassword, DUMMY_PASSWORD_HASH);
  } catch (cause) {
    if (dummyHashUnreadableReported) return;
    dummyHashUnreadableReported = true;
    logger.warn(
      "Login timing equalisation is inactive: the password hasher could not verify the dummy hash",
      { cause: cause instanceof Error ? cause.name : typeof cause },
    );
  }
}

/**
 * Authenticates a password account.
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
 * the answer refuses to. Malformed input uses dummy lookup values so it keeps
 * the same storage and verification call profile without sending the invalid
 * caller value to a gateway.
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
    if (container.identity) {
      await container.identity.findPasswordCredential(DUMMY_LOOKUP_EMAIL);
    }
    await burnVerificationTime(
      container.passwordHasher,
      input.password as PlainPassword,
      container.logger,
    );
    if (container.identity) {
      await container.identity.getAccountAuthority(DUMMY_AUTHORITY_USER_ID);
    }
    throw invalidCredentials();
  }

  if (!container.identity)
    throw new Error("Identity gateway is not configured");
  const found = await container.identity.findPasswordCredential(email);
  if (!found) {
    await burnVerificationTime(
      container.passwordHasher,
      plainPassword,
      container.logger,
    );
    await container.identity.getAccountAuthority(DUMMY_AUTHORITY_USER_ID);
    throw invalidCredentials();
  }

  const matches = await container.passwordHasher.verify(
    plainPassword,
    found.passwordHash,
  );
  const authority = await container.identity.getAccountAuthority(found.userId);
  const referenceIsCurrent = authority?.credentials.some(
    (credential) =>
      credential.credentialId === found.credentialId &&
      credential.directoryReferences.includes(found.directoryReference),
  );
  if (
    authority?.status !== "active" ||
    !matches ||
    authority.operationEpoch !== found.accountEpoch ||
    referenceIsCurrent !== true
  ) {
    throw invalidCredentials();
  }

  return { userId: found.userId, sessionEpoch: authority.sessionEpoch };
}
