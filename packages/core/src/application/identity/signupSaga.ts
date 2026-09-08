import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { ConflictError, isConflictError } from "../errors";
import type { UsecaseContainer } from "../types";
import type { CredentialRefDto } from "./gateway";

/** The first credential version both sides start from. */
export const INITIAL_CREDENTIAL_VERSION = 1;

export type SignupConflictCode =
  | "EMAIL_ALREADY_REGISTERED"
  | "SSO_IDENTITY_ALREADY_REGISTERED";

export type SignupCredential = Readonly<{
  locator: MappingLocator;
  credential: CredentialRefDto;
  canonical: string;
  passwordVerifier: string | null;
  /** The `ConflictError` code a lost reservation of this credential reports. */
  conflictCode: SignupConflictCode;
}>;

export type SignupSagaInput = Readonly<{
  userId: string;
  operationId: string;
  callerToken: string;
  /** The first entry is the coordinator. */
  credentials: readonly [SignupCredential, ...SignupCredential[]];
}>;

export function mappingOf(locator: {
  generation: number;
  bucketIndex: number;
  hmac: string;
}): string {
  return `g${locator.generation}:b${locator.bucketIndex}:${locator.hmac}`;
}

const CONFLICT_MESSAGE: Record<SignupConflictCode, string> = {
  EMAIL_ALREADY_REGISTERED: "This email address is already registered",
  SSO_IDENTITY_ALREADY_REGISTERED: "This SSO identity is already registered",
};

function conflictOf(credential: SignupCredential): ConflictError {
  return new ConflictError(
    credential.conflictCode,
    CONFLICT_MESSAGE[credential.conflictCode],
  );
}

/**
 * S-AC-01 / S-AC-02's registration saga. Uniqueness is decided by winning
 * the reservations, never by a read beforehand. The writes span two
 * physical boundaries and are therefore a saga: every reservation
 * (phase 1) → account initialisation (phase 2) → every activation
 * (phase 3) → every reverse-index record (phase 4). A saga cut short is
 * re-driven by the coordinator bucket's `resume-signup` job.
 *
 * Between phases 2 and 3 the coordinator writes the `saga_committed` mark
 * on its reservation row (`spec/recovery/index.md`, 予約 TTL の不等式):
 * from here on an account exists, so the row must outlive its TTL until
 * the saga finishes or its cleanup runs, and the mark is what holds
 * `sweep-reservations` off it.
 *
 * A reservation lost after another was already won is handed back
 * (`cancelReservation`, by the caller token) before the conflict is
 * reported, so a two-credential signup never leaves a stray hold.
 */
export async function runSignupSaga(
  container: UsecaseContainer,
  input: SignupSagaInput,
): Promise<void> {
  const gateway = container.identityGateway;
  const now = container.clock.now();
  const reservedUntil = new Date(
    now.getTime() + container.identityTuning.reservationTtlMs,
  );
  const [coordinator] = input.credentials;
  const allLocators = input.credentials.map((c) => c.locator);

  const won: SignupCredential[] = [];
  for (const credential of input.credentials) {
    try {
      await gateway.reserveCredential(credential.locator, {
        saga: "signup",
        operationId: input.operationId,
        candidateUserId: input.userId,
        callerToken: input.callerToken,
        canonical: credential.canonical,
        passwordVerifier: credential.passwordVerifier,
        reservedUntil,
        coordinator:
          credential === coordinator
            ? { role: "coordinator", locators: allLocators }
            : {
                role: "member",
                coordinatorLocator: mappingOf(coordinator.locator),
              },
      });
      won.push(credential);
    } catch (error) {
      for (const held of won) {
        await gateway.cancelReservation(held.locator, input.callerToken);
      }
      throw isConflictError(error) ? conflictOf(credential) : error;
    }
  }

  await gateway.initializeAccount(input.userId, {
    operationId: input.operationId,
    callerToken: input.callerToken,
    credentials: input.credentials.map((c) => c.credential),
    locators: allLocators,
  });

  const committed = await gateway.commitSignupSaga(
    coordinator.locator,
    input.operationId,
  );
  if (!committed) throw conflictOf(coordinator);

  for (const credential of input.credentials) {
    const activated = await gateway.activateReservation(
      credential.locator,
      input.operationId,
      input.userId,
    );
    if (!activated) throw conflictOf(credential);
  }

  for (const credential of input.credentials) {
    await gateway.recordSignupLocator(input.userId, {
      operationId: input.operationId,
      locator: {
        credentialId: credential.credential.credentialId,
        kind: credential.credential.kind,
        mapping: mappingOf(credential.locator),
        credentialVersion: INITIAL_CREDENTIAL_VERSION,
        usableForLogin: credential.credential.usableForLogin,
        label: credential.credential.label,
      },
    });
  }
}
