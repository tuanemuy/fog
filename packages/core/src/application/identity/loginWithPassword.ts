import { isBusinessRuleError } from "@repo/core/domain/error";
import {
  Email,
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { ValidationError } from "../errors";
import type { ServiceArgs } from "../types";
import type { IdentityTuning } from "./tuning";

export type LoginWithPasswordInput = Readonly<{
  email: string;
  password: string;
}>;

export type LoginWithPasswordOutput = Readonly<{ userId: string }>;

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

// One message and no field: naming a field would say which half was wrong.
function invalidCredentials(): ValidationError {
  return new ValidationError(
    "INVALID_CREDENTIALS",
    INVALID_CREDENTIALS_MESSAGE,
  );
}

// Fed to the hasher on every path that never reaches a real verifier, so the
// derivation cost is paid whether or not the address is registered.
const DUMMY_PASSWORD = "dummy-password-never-verified";

/**
 * Rule ii: one failure is forgiven per `loginAttemptDecayMs` elapsed since
 * `nextAttemptAllowedAt` — the failure's own time below the threshold, the
 * lockout's end above it. Applied at read time; it reaches storage only when
 * the failure write-back's CAS matches.
 */
export function decayedFailedAttempts(
  failedAttempts: number,
  nextAttemptAllowedAt: Date | null,
  now: Date,
  tuning: IdentityTuning,
): number {
  if (nextAttemptAllowedAt === null) return failedAttempts;
  const elapsed = now.getTime() - nextAttemptAllowedAt.getTime();
  if (elapsed <= 0) return failedAttempts;
  return Math.max(
    0,
    failedAttempts - Math.floor(elapsed / tuning.loginAttemptDecayMs),
  );
}

/** Rule i: the lockout doubles per failure past the threshold and stops at the cap. */
export function lockoutWidthMs(
  failedAttempts: number,
  tuning: IdentityTuning,
): number {
  if (failedAttempts < tuning.loginLockoutThreshold) return 0;
  const exponent = failedAttempts - tuning.loginLockoutThreshold;
  return Math.min(
    tuning.loginLockoutBaseMs * 2 ** exponent,
    tuning.loginLockoutMaxMs,
  );
}

/**
 * S-AC-03. Every failure — malformed input, unknown address, reservation,
 * SSO-only, in-flight change, lockout, wrong password, unreachable
 * credential — is the same `ValidationError("INVALID_CREDENTIALS")`, and the
 * five that never reach a real verifier still pay one key derivation.
 * Rule iii: a throttled attempt reports nothing and moves no counter.
 */
export async function loginWithPassword({
  container,
  input,
}: ServiceArgs<LoginWithPasswordInput>): Promise<LoginWithPasswordOutput> {
  const now = container.clock.now();
  const tuning = container.identityTuning;
  const hasher = container.passwordHasher;
  const gateway = container.identityGateway;

  let email: Email;
  let password: PlainPassword;
  try {
    email = Email.create(input.email);
    password = PlainPassword.create(input.password);
  } catch (error) {
    if (isBusinessRuleError(error)) throw invalidCredentials();
    throw error;
  }

  const resolved = await gateway.resolveLoginCredential(email);
  const verifier = resolved?.passwordVerifier ?? null;
  const throttled =
    resolved !== null &&
    resolved.nextAttemptAllowedAt !== null &&
    resolved.nextAttemptAllowedAt.getTime() > now.getTime();
  if (
    resolved === null ||
    resolved.userId === null ||
    verifier === null ||
    resolved.changeState !== null ||
    throttled
  ) {
    await hasher.hash(PlainPassword.create(DUMMY_PASSWORD));
    throw invalidCredentials();
  }

  const matched = await hasher.verify(password, PasswordHash.create(verifier));
  if (!matched) {
    const decayed = decayedFailedAttempts(
      resolved.failedAttempts,
      resolved.nextAttemptAllowedAt,
      now,
      tuning,
    );
    const failedAttempts = decayed + 1;
    const width = lockoutWidthMs(failedAttempts, tuning);
    await gateway.recordAttemptOutcome(resolved.coordinate, {
      outcome: "failure",
      observedFailedAttempts: resolved.failedAttempts,
      failedAttempts,
      nextAttemptAllowedAt: new Date(now.getTime() + width),
    });
    throw invalidCredentials();
  }

  const locator = await gateway.findCredentialLocator(
    resolved.userId,
    resolved.coordinate.credentialId,
  );
  if (
    locator === null ||
    locator.credentialVersion !== resolved.credentialVersion
  ) {
    throw invalidCredentials();
  }

  await gateway.recordAttemptOutcome(resolved.coordinate, {
    outcome: "success",
  });
  return { userId: resolved.userId };
}
