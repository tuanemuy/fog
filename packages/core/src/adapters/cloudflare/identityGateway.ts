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
  encodeMapping,
  ssoCanonical,
} from "./crypto/locatorDerivation";
import {
  callDurableObject,
  type DurableObjectBindings,
  directoryStub,
  userDataStub,
} from "./doStubs";
import type { IdentityDirectoryDurableObject } from "./identityDirectoryDurableObject";
import { parseResetToken } from "./stores/passwordResetTokenStore";
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

  /** Generation order — active, previous, then active once more — and the locator that answered (the active one when none did). */
  const locate = async (
    kind: CredentialKind,
    canonical: string,
  ): Promise<{ found: LoginCredentialDto | null; locator: DerivedLocator }> => {
    const entries = deps.keyring.entries;
    const probeOne = async (entry: (typeof entries)[number]) => {
      const locator = await deriveLocator(entry, kind, canonical);
      const found = await callDurableObject(() =>
        directory(locator).resolveLoginCredential(locator),
      );
      return { found, locator };
    };
    for (const entry of entries) {
      const result = await probeOne(entry);
      if (result.found !== null) return result;
    }
    return probeOne(activeKey(deps.keyring));
  };
  const probe = async (
    kind: CredentialKind,
    canonical: string,
  ): Promise<LoginCredentialDto | null> =>
    (await locate(kind, canonical)).found;
  const resumeAt = () =>
    new Date(deps.clock.now().getTime() + deps.tuning.signupResumeDelayMs);

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

    async changeTrashRetentionDays(userId, retentionDays) {
      await callDurableObject(() =>
        userData(userId).changeTrashRetentionDays({ retentionDays }),
      );
    },

    async requestPasswordReset(canonicalEmail) {
      const { locator } = await locate("email", canonicalEmail);
      await callDurableObject(() =>
        directory(locator).requestPasswordReset({
          hmac: locator.hmac,
          mapping: encodeMapping(locator),
        }),
      );
    },

    async consumeResetToken(token) {
      const parts = parseResetToken(token);
      if (parts === null) return null;
      return callDurableObject(() => directory(parts).consumeResetToken(token));
    },

    async cancelReservation(locator, callerToken) {
      await callDurableObject(() =>
        directory(locator).cancelReservation({ locator, callerToken }),
      );
    },

    async beginCredentialChange(coordinate, dto) {
      return callDurableObject(() =>
        directory(coordinateLocator(coordinate)).beginCredentialChange({
          coordinate,
          dto,
          resumeAt: resumeAt(),
        }),
      );
    },

    async applyCredentialChange(userId, dto) {
      return callDurableObject(() =>
        userData(userId).applyCredentialChange(dto),
      );
    },

    async markCredentialChangeAdvanced(coordinate, operationId) {
      return callDurableObject(() =>
        directory(coordinateLocator(coordinate)).markCredentialChangeAdvanced({
          coordinate,
          operationId,
        }),
      );
    },

    async promoteVerifier(coordinate, dto) {
      return callDurableObject(() =>
        directory(coordinateLocator(coordinate)).promoteVerifier({
          coordinate,
          dto,
        }),
      );
    },

    async readCredentialForChange(coordinate) {
      const locator = coordinateLocator(coordinate);
      return callDurableObject(() =>
        directory(locator).resolveLoginCredential({
          kind: coordinate.kind,
          hmac: locator.hmac,
          generation: locator.generation,
          bucketIndex: locator.bucketIndex,
        }),
      );
    },

    async resolveSsoIdentity(provider, providerSubject) {
      return probe("sso", ssoCanonical(provider, providerSubject));
    },

    async beginLink(userId, dto) {
      return callDurableObject(() =>
        userData(userId).beginLink({ dto, resumeAt: resumeAt() }),
      );
    },

    async completeLink(userId, dto) {
      await callDurableObject(() => userData(userId).completeLink(dto));
    },

    async finishLink(userId, dto) {
      await callDurableObject(() => userData(userId).finishLink(dto));
    },

    async beginUnlink(userId, dto) {
      return callDurableObject(() =>
        userData(userId).beginUnlink({ dto, resumeAt: resumeAt() }),
      );
    },

    async deleteMapping(coordinate, dto) {
      await callDurableObject(() =>
        directory(coordinateLocator(coordinate)).deleteMapping({
          coordinate,
          dto,
        }),
      );
    },

    async finishUnlink(userId, dto) {
      await callDurableObject(() => userData(userId).finishUnlink(dto));
    },

    async revokeAllAiClientConnections(userId) {
      return callDurableObject(() =>
        userData(userId).revokeAllAiClientConnections(),
      );
    },

    async approveAiClientAuthorization(userId, dto) {
      return callDurableObject(() =>
        userData(userId).approveAiClientAuthorization(dto),
      );
    },

    async listAiClientConnections(userId) {
      return callDurableObject(() =>
        userData(userId).listAiClientConnections(),
      );
    },

    async revokeAiClientConnection(userId, connectionId) {
      await callDurableObject(() =>
        userData(userId).revokeAiClientConnection(connectionId),
      );
    },

    async authorizeAiClient(userId, connectionId) {
      return callDurableObject(() =>
        userData(userId).authorizeAiClient({ connectionId }),
      );
    },

    async consumeAuthorizationCode(userId, dto) {
      return callDurableObject(() =>
        userData(userId).consumeAuthorizationCode(dto),
      );
    },

    async revealCanonical(coordinate, userId) {
      const locator = coordinateLocator(coordinate);
      return callDurableObject(() =>
        directory(locator).revealCanonical({ coordinate, userId }),
      );
    },
  };
}
