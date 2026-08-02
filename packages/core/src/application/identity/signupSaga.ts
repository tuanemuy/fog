import type { LocatorRef } from "@repo/core/application/execution/jobs";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { DirectoryLocator } from "@repo/core/lib/directoryLocator";
import { ConflictError } from "../errors";
import { unwrap } from "../rpc/restoreError";
import type { UsecaseContainer } from "../types";

/**
 * The account-creation saga, orchestrated from the request Worker.
 *
 * There is no distributed transaction between Durable Objects, so this is a
 * resumable saga instead. Phases 0–4 below correspond one-to-one with
 * `.thread/34/design.md` §6.3.
 *
 * ## Nothing here is supplied by the client
 *
 * `operationId`, the candidate `userId`, the `callerToken` and every
 * `credentialId` are minted fresh, server-side, on every attempt. A
 * client-supplied idempotency key would end up as the argument to `idFromName`,
 * and an attacker who learned somebody's `userId` (it appears in revision
 * actors and export headers) could then write into their Durable Object without
 * authenticating.
 *
 * **So "re-send across requests" is not a concept this saga has.** A re-posted
 * form mints a whole new operation; convergence is the reservation row's job,
 * not the id's. A stalled saga is driven forward only by the coordinator's
 * Alarm.
 */

export type SignupCredentialInput = Readonly<{
  kind: CredentialMappingKind;
  canonical: string;
  label: string;
  /** Present for the password credential only. */
  passwordVerifier?: string;
}>;

export type SignupResult = Readonly<{
  userId: string;
  sessionEpoch: number;
}>;

type ResolvedCredential = Readonly<{
  credentialId: string;
  kind: CredentialMappingKind;
  label: string;
  passwordVerifier?: string;
  locators: readonly DirectoryLocator[];
}>;

/** Reservation TTL. Long enough to outlive a stalled saga's first retries. */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

export async function runSignupSaga(
  container: UsecaseContainer,
  credentials: readonly SignupCredentialInput[],
): Promise<SignupResult> {
  const now = container.clock.now();

  // --- phase 0: mint identifiers and resolve locators -----------------------
  const operationId = container.idGenerator.next();
  const userId = container.idGenerator.next();
  const callerToken = container.idGenerator.next();

  const resolved: ResolvedCredential[] = [];
  for (const credential of credentials) {
    resolved.push({
      credentialId: container.idGenerator.next(),
      kind: credential.kind,
      label: credential.label,
      // Absent, not `undefined`: "holds no verifier" is what makes an address
      // reservation fail the `usableForLogin` test.
      ...(credential.passwordVerifier === undefined
        ? {}
        : { passwordVerifier: credential.passwordVerifier }),
      locators: await container.directoryLocator.forCanonical(
        credential.canonical,
      ),
    });
  }

  // Sorted on `(kind, full-length hmac)` with `'email' < 'sso'`. The rule is
  // deterministic, so every actor computes the same coordinator without any
  // negotiation — and two concurrent signups can never take the same pair of
  // buckets in opposite orders.
  const ordered = [...resolved].sort(compareCredentials);
  const coordinator = ordered[0];
  if (coordinator === undefined) {
    throw new Error("A signup must present at least one credential");
  }
  const coordinatorLocator = activeLocator(coordinator);
  const targetLocators = ordered.flatMap((credential) =>
    credential.locators.map((locator) => toLocatorRef(credential, locator)),
  );
  const payloadDigest = digestOf(targetLocators);

  // --- phase 1a: reserve in the coordinator bucket --------------------------
  // The previous generation is consulted first: while a routing-key rotation is
  // in flight, uniqueness has to hold across both generations, not just the
  // active one.
  for (const credential of ordered) {
    await assertPreviousGenerationFree(container, credential);
  }
  await reserve(container, coordinator, {
    operationId,
    userId,
    callerToken,
    reservedUntil: now.getTime() + RESERVATION_TTL_MS,
    isCoordinator: true,
    locators: targetLocators,
    coordinatorLocator: coordinatorLocator.doName,
  });

  // --- phase 1b: reserve in the remaining buckets ---------------------------
  // Empty for a password signup, which has exactly one credential. A loss here
  // is compensated by the coordinator cancelling every reservation — phase 2
  // has not run, so nothing else needs unwinding.
  const rest = ordered.slice(1);
  try {
    for (const credential of rest) {
      await reserve(container, credential, {
        operationId,
        userId,
        callerToken,
        reservedUntil: now.getTime() + RESERVATION_TTL_MS,
        isCoordinator: false,
        coordinatorLocator: coordinatorLocator.doName,
      });
    }
  } catch (error) {
    await cancelAll(container, ordered, operationId, callerToken);
    throw error;
  }

  // --- phase 2: initialise the account --------------------------------------
  const userData = container.userDataStubFactory(userId);
  unwrap(
    await userData.initializeAccount({
      userId,
      operationId,
      payloadDigest,
      callerToken,
      targetLocators,
    }),
  );

  // --- phase 3: promote every reservation ------------------------------------
  for (const credential of ordered) {
    const locator = activeLocator(credential);
    unwrap(
      await container
        .directoryStubFactory(locator)
        .activateReservation(
          credential.kind,
          locator.hmac,
          operationId,
          userId,
        ),
    );
  }

  // --- phase 4: record the reverse locators and finish ------------------------
  // The locator write and `phase = 'done'` land in **one** transaction inside
  // the DO; see `recordCredentialLocator` for why splitting them would create a
  // permanently reachable half-finished account.
  for (const credential of ordered) {
    for (const locator of credential.locators) {
      unwrap(
        await userData.recordCredentialLocator({
          operationId,
          payloadDigest,
          callerToken,
          credentialId: credential.credentialId,
          kind: credential.kind,
          hmac: locator.hmac,
          generation: locator.generation,
          bucketIndex: locator.bucketIndex,
          credentialVersion: 0,
          // The Directory decides this, and carries it here: an email
          // credential is a way in only while it holds a verifier, which is
          // what keeps an SSO-only account's address reservation from counting
          // as one.
          usableForLogin:
            credential.kind === "sso" ||
            credential.passwordVerifier !== undefined,
          label: credential.label,
        }),
      );
    }
  }

  const account = unwrap(
    await userData.verifyLogin({
      userId,
      credentialId: coordinator.credentialId,
      credentialVersion: 0,
    }),
  );
  return { userId, sessionEpoch: account.sessionEpoch };
}

async function assertPreviousGenerationFree(
  container: UsecaseContainer,
  credential: ResolvedCredential,
): Promise<void> {
  for (const locator of credential.locators.slice(1)) {
    const taken = unwrap(
      await container
        .directoryStubFactory(locator)
        .checkPreviousGeneration(credential.kind, locator.hmac),
    );
    if (taken) {
      throw alreadyRegistered(credential.kind);
    }
  }
}

async function reserve(
  container: UsecaseContainer,
  credential: ResolvedCredential,
  args: Readonly<{
    operationId: string;
    userId: string;
    callerToken: string;
    reservedUntil: number;
    isCoordinator: boolean;
    locators?: readonly LocatorRef[];
    coordinatorLocator: string;
  }>,
): Promise<void> {
  const locator = activeLocator(credential);
  unwrap(
    await container.directoryStubFactory(locator).reserveCredential({
      kind: credential.kind,
      hmac: locator.hmac,
      generation: locator.generation,
      credentialId: credential.credentialId,
      candidateUserId: args.userId,
      operationId: args.operationId,
      callerToken: args.callerToken,
      reservedUntil: args.reservedUntil,
      isCoordinator: args.isCoordinator,
      ...(credential.passwordVerifier === undefined
        ? {}
        : { passwordVerifier: credential.passwordVerifier }),
      ...(args.locators === undefined ? {} : { locators: args.locators }),
      // Only a non-coordinator row points back at the coordinator.
      ...(args.isCoordinator
        ? {}
        : { coordinatorLocator: args.coordinatorLocator }),
    }),
  );
}

async function cancelAll(
  container: UsecaseContainer,
  credentials: readonly ResolvedCredential[],
  operationId: string,
  callerToken: string,
): Promise<void> {
  for (const credential of credentials) {
    const locator = activeLocator(credential);
    // Best effort: the sweep reclaims anything left behind after the TTL, so a
    // failure here must not mask the original loss.
    await container
      .directoryStubFactory(locator)
      .cancelReservation(
        credential.kind,
        locator.hmac,
        operationId,
        callerToken,
      )
      .catch(() => undefined);
  }
}

function activeLocator(credential: ResolvedCredential): DirectoryLocator {
  const locator = credential.locators[0];
  if (locator === undefined) {
    throw new Error("The routing keyring produced no active locator");
  }
  return locator;
}

function toLocatorRef(
  credential: ResolvedCredential,
  locator: DirectoryLocator,
): LocatorRef {
  return {
    credentialId: credential.credentialId,
    kind: credential.kind,
    hmac: locator.hmac,
    generation: locator.generation,
    bucketIndex: locator.bucketIndex,
  };
}

function compareCredentials(
  a: ResolvedCredential,
  b: ResolvedCredential,
): number {
  if (a.kind !== b.kind) return a.kind === "email" ? -1 : 1;
  const left = activeLocator(a).hmac;
  const right = activeLocator(b).hmac;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable over the operation's target set; the DO compares it on a replay. */
function digestOf(locators: readonly LocatorRef[]): string {
  const json = JSON.stringify(locators);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function alreadyRegistered(kind: CredentialMappingKind): Error {
  return kind === "email"
    ? new ConflictError(
        "EMAIL_ALREADY_REGISTERED",
        "That email address is already registered",
      )
    : new ConflictError(
        "SSO_IDENTITY_ALREADY_REGISTERED",
        "That SSO identity is already registered",
      );
}
