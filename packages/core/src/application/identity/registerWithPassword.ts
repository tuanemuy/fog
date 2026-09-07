import { Email, PlainPassword } from "@repo/core/domain/identity/valueObject";
import { ConflictError } from "../errors";
import type { ServiceArgs } from "../types";
import { newCallerToken } from "./callerToken";

export type RegisterWithPasswordInput = Readonly<{
  email: string;
  password: string;
}>;

export type RegisterWithPasswordOutput = Readonly<{ userId: string }>;

/** The first credential version both sides start from. */
export const INITIAL_CREDENTIAL_VERSION = 1;

/**
 * S-AC-01. Uniqueness is decided by winning the reservation, never by a read
 * beforehand. The four writes span two physical boundaries and are therefore
 * a saga: reservation (phase 1) → account initialisation (phase 2) →
 * reservation activation (phase 3) → reverse-index record (phase 4). A saga
 * cut short is re-driven by the coordinator bucket's `resume-signup` job.
 *
 * Between phases 2 and 3 the coordinator writes the `saga_committed` mark
 * on its reservation row (`spec/recovery/index.md`, 予約 TTL の不等式):
 * from here on an account exists, so the row must outlive its TTL until
 * the saga finishes or its cleanup runs, and the mark is what holds
 * `sweep-reservations` off it.
 */
export async function registerWithPassword({
  container,
  input,
}: ServiceArgs<RegisterWithPasswordInput>): Promise<RegisterWithPasswordOutput> {
  const now = container.clock.now();
  const userId = container.idGenerator.next();
  const credentialId = container.idGenerator.next();
  const operationId = container.idGenerator.next();
  const callerToken = newCallerToken(container.tokenGenerator);

  const email = Email.create(input.email);
  const password = PlainPassword.create(input.password);
  const verifier = await container.passwordHasher.hash(password);

  const gateway = container.identityGateway;
  const locator = await gateway.deriveCredentialLocator(
    "email",
    email,
    credentialId,
  );
  await gateway.reserveCredential(locator, {
    operationId,
    candidateUserId: userId,
    callerToken,
    canonical: email,
    passwordVerifier: verifier,
    reservedUntil: new Date(
      now.getTime() + container.identityTuning.reservationTtlMs,
    ),
    coordinator: { role: "coordinator", locators: [locator] },
  });

  await gateway.initializeAccount(userId, {
    operationId,
    callerToken,
    credential: {
      credentialId,
      kind: "email",
      label: "",
      usableForLogin: true,
    },
    locators: [locator],
  });

  const committed = await gateway.commitSignupSaga(locator, operationId);
  if (!committed) {
    throw new ConflictError(
      "EMAIL_ALREADY_REGISTERED",
      "This email address is already registered",
    );
  }

  const activated = await gateway.activateReservation(
    locator,
    operationId,
    userId,
  );
  if (!activated) {
    throw new ConflictError(
      "EMAIL_ALREADY_REGISTERED",
      "This email address is already registered",
    );
  }

  await gateway.recordSignupLocator(userId, {
    operationId,
    locator: {
      credentialId,
      kind: "email",
      mapping: mappingOf(locator),
      credentialVersion: INITIAL_CREDENTIAL_VERSION,
      usableForLogin: true,
      label: "",
    },
  });

  return { userId };
}

function mappingOf(locator: {
  generation: number;
  bucketIndex: number;
  hmac: string;
}): string {
  return `g${locator.generation}:b${locator.bucketIndex}:${locator.hmac}`;
}
