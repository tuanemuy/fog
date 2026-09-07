import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  AttemptOutcomeDto,
  CredentialCoordinateDto,
  IdentityGateway,
  LoginCredentialDto,
} from "@repo/core/application/identity/gateway";
import type { IdentityTuning } from "@repo/core/application/identity/tuning";
import type { Clock } from "@repo/core/application/ports/clock";
import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { activeKey, type MappingKeyring } from "./crypto/keyring";
import {
  type DerivedLocator,
  decodeMapping,
  deriveLocator,
} from "./crypto/locatorDerivation";
import {
  callDurableObject,
  type DurableObjectBindings,
  directoryStub,
  userDataStub,
} from "./doStubs";
import type { IdentityDirectoryDurableObject } from "./identityDirectoryDurableObject";
import type { UserDataDurableObject } from "./userDataDurableObject";

export type IdentityGatewayDeps = Readonly<{
  bindings: DurableObjectBindings;
  keyring: MappingKeyring;
  clock: Clock;
  tuning: IdentityTuning;
}>;

function coordinateLocator(
  coordinate: CredentialCoordinateDto,
): DerivedLocator {
  const derived = decodeMapping(coordinate.kind, coordinate.mapping);
  if (derived === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The credential coordinate carries an unreadable mapping",
    );
  }
  return derived;
}

/**
 * The request Worker's implementation of `IdentityGateway`: locator
 * derivation with the mapping keyring (which this side alone holds), stub
 * selection, and the envelope unwrap. Canonical lookups probe the keyring
 * active → previous and re-probe active once when both miss
 * (`spec/database/index.md`, lookup の世代順序).
 */
export function createIdentityGateway(
  deps: IdentityGatewayDeps,
): IdentityGateway {
  const userData = (userId: string) =>
    userDataStub(
      deps.bindings.USER_DATA,
      userId,
    ) as unknown as UserDataDurableObject;
  const directory = (locator: { generation: number; bucketIndex: number }) =>
    directoryStub(
      deps.bindings.IDENTITY_DIRECTORY,
      locator,
    ) as unknown as IdentityDirectoryDurableObject;

  const probe = async (
    kind: CredentialKind,
    canonical: string,
  ): Promise<LoginCredentialDto | null> => {
    const entries = deps.keyring.entries;
    const probeOne = async (entry: (typeof entries)[number]) => {
      const locator = await deriveLocator(entry, kind, canonical);
      return callDurableObject(() =>
        directory(locator).resolveLoginCredential(locator),
      );
    };
    for (const entry of entries) {
      const found = await probeOne(entry);
      if (found !== null) return found;
    }
    if (entries.length > 1) return probeOne(activeKey(deps.keyring));
    return null;
  };

  return {
    async readAccountState(userId) {
      return callDurableObject(() => userData(userId).readAccountState());
    },

    async deriveCredentialLocator(kind, canonical, credentialId) {
      const derived = await deriveLocator(
        activeKey(deps.keyring),
        kind,
        canonical,
      );
      return {
        credentialId,
        kind,
        hmac: derived.hmac,
        generation: derived.generation,
        bucketIndex: derived.bucketIndex,
      };
    },

    async reserveCredential(locator, dto) {
      await callDurableObject(() =>
        directory(locator).reserveCredential({
          locator,
          dto,
          resumeAt: new Date(
            deps.clock.now().getTime() + deps.tuning.signupResumeDelayMs,
          ),
        }),
      );
    },

    async initializeAccount(userId, input) {
      await callDurableObject(() => userData(userId).initializeAccount(input));
    },

    async commitSignupSaga(locator, operationId) {
      return callDurableObject(() =>
        directory(locator).commitSaga({ locator, operationId }),
      );
    },

    async activateReservation(locator, operationId, userId) {
      return callDurableObject(() =>
        directory(locator).activateReservation({
          locator,
          operationId,
          userId,
        }),
      );
    },

    async recordSignupLocator(userId, input) {
      await callDurableObject(() =>
        userData(userId).recordSignupLocator(input),
      );
    },

    async resolveLoginCredential(canonicalEmail) {
      return probe("email", canonicalEmail);
    },

    async recordAttemptOutcome(coordinate, outcome: AttemptOutcomeDto) {
      const locator = coordinateLocator(coordinate);
      await callDurableObject(() =>
        directory(locator).recordAttemptOutcome({ coordinate, outcome }),
      );
    },

    async findCredentialLocator(userId, credentialId) {
      return callDurableObject(() =>
        userData(userId).findCredentialLocator(credentialId),
      );
    },

    async readCurrentUser(userId) {
      return callDurableObject(() => userData(userId).readCurrentUser());
    },

    async revealCanonical(coordinate, userId) {
      const locator = coordinateLocator(coordinate);
      return callDurableObject(() =>
        directory(locator).revealCanonical({ coordinate, userId }),
      );
    },
  };
}
