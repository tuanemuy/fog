import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import {
  Email,
  PasswordHash,
  PlainPassword,
} from "@repo/core/domain/identity/valueObject";
import { DUMMY_PASSWORD_HASH_ITERATIONS } from "@repo/core/lib/passwordHashing";
import { ValidationError } from "../errors";
import type { Logger } from "../ports/logger";
import { unwrap } from "../rpc/restoreError";
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

/**
 * A throwaway hash, in the `PasswordHasher` adapter's stored encoding, of a
 * password nobody holds. It exists so a login that finds no password account
 * still pays for one key derivation — see `burnVerificationTime`.
 *
 * Only the declared cost has to be current; the salt and digest are arbitrary
 * bytes, since no password is ever meant to match them. `verify` reads the cost
 * out of the value it is handed, which is why that number — shared with the
 * shipped hasher through `lib/passwordHashing.ts` — is what makes the burn cost
 * what a real verification costs.
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
 * Runs one verification whose outcome is discarded, so the "no such account"
 * and "wrong password" paths take comparable time.
 *
 * The result cannot matter and neither can a failure: a hasher that cannot
 * parse {@link DUMMY_PASSWORD_HASH} must not turn an unknown address into a
 * 500. That degrades the equalisation back to no equalisation rather than
 * breaking login, which is why this is the one place a throw is swallowed — and
 * why it is logged, since the request is unaffected and the warning is the only
 * signal that the mitigation has stopped working.
 *
 * Only the failure's *type* is logged, never the value: the `PasswordHasher`
 * contract forbids putting a `PlainPassword` in what it throws, and projecting
 * to a name keeps that promise from being the only thing between a swapped-in
 * hasher and a plaintext password in the logs.
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
 * The stored verifier as a `PasswordHash`, or `null` if the row holds
 * something that is not one.
 *
 * A branded cast would have the type system assert a validation that never
 * ran; `create` *is* the validation, and this is the value-object construction
 * point the two-point rule names. A row that fails it is corrupt rather than
 * wrong, but it still has to level: skipping the locator sends the attempt
 * down the same path an unknown address takes, whereas a distinct failure
 * would tell an unauthenticated caller that this address exists.
 */
function toPasswordHash(raw: string): PasswordHash | null {
  try {
    return PasswordHash.create(raw);
  } catch {
    return null;
  }
}

/**
 * Authenticates a password account.
 *
 * Every way this can fail — malformed email, password outside the length
 * bounds, unknown address, an SSO-only account, a change in flight, a wrong
 * password — produces the identical `ValidationError("INVALID_CREDENTIALS")`.
 * That uniformity is the feature. Response time is levelled the same way: an
 * address with no password account still pays for one key derivation.
 *
 * ## Three RPCs, and why that is not one too many
 *
 * 1. `lookup-credential` on the Directory bucket, which answers unconditionally
 *    and hands back dummy material for every non-usable case;
 * 2. `verify-login` on the User Data DO, which checks the account state, the
 *    reachability of the credential and its version;
 * 3. `report-login-result` back on the bucket.
 *
 * A failed comparison skips (2), so that path is two. The write-back in (3) is
 * unavoidable: the comparison itself runs here, in the request Worker, because
 * key derivation must not occupy a Durable Object — so the counters cannot be
 * updated as a side effect of a read. It is issued on **both** outcomes and
 * awaited before responding, since a failure report a caller can dodge by
 * dropping the connection is not a deterrent.
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

  const locators = await container.directoryLocator.forCanonical(email);
  // Active generation first, then the previous one: during a rotation the row
  // may still live under the old key.
  for (const locator of locators) {
    const bucket = container.directoryStubFactory(locator);
    const found = unwrap(
      await bucket.lookupCredential({
        kind: "email",
        hmac: locator.hmac,
        generation: locator.generation,
        bucketIndex: locator.bucketIndex,
      }),
    );

    // The other two arms carry no verification material at all — an SSO row
    // resolves an identity but is not a password login, and `none` is the
    // levelled answer the bucket gives to all four non-usable cases.
    if (found.outcome !== "password") continue;
    const verifier = toPasswordHash(found.passwordVerifier);
    if (verifier === null) continue;

    const matches = await container.passwordHasher.verify(
      plainPassword,
      verifier,
    );
    unwrap(await bucket.reportLoginResult("email", locator.hmac, matches));
    if (!matches) throw invalidCredentials();

    const account = unwrap(
      await container.userDataStubFactory(found.userId).verifyLogin({
        userId: found.userId,
        credentialId: found.credentialId,
        credentialVersion: found.credentialVersion,
      }),
    );
    return { userId: found.userId, sessionEpoch: account.sessionEpoch };
  }

  await burnVerificationTime(
    container.passwordHasher,
    plainPassword,
    container.logger,
  );
  throw invalidCredentials();
}
