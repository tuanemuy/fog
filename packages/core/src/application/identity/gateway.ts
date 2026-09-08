import type { AccountState } from "@repo/core/domain/identity/ports/accountStore";
import type {
  CredentialChangeOrigin,
  CredentialChangeState,
  CredentialKind,
  MappingLocator,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";

/** `CredentialCoordinate` as it crosses the request Worker ↔ DO boundary. */
export type CredentialCoordinateDto = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  mapping: string;
}>;

/** `CredentialLocator` as primitives. */
export type CredentialLocatorDto = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  mapping: string;
  credentialVersion: number;
  usableForLogin: boolean;
  label: string;
}>;

/**
 * The row-resolution answer of a login. The verifier rides along because this
 * is the one response allowed to carry it (`spec/domains/identity.md`).
 */
export type LoginCredentialDto = Readonly<{
  coordinate: CredentialCoordinateDto;
  userId: string | null;
  credentialVersion: number;
  changeState: CredentialChangeState | null;
  changeOrigin: CredentialChangeOrigin | null;
  failedAttempts: number;
  nextAttemptAllowedAt: Date | null;
  passwordVerifier: string | null;
}>;

export type AttemptOutcomeDto =
  | Readonly<{ outcome: "success" }>
  | Readonly<{
      outcome: "failure";
      observedFailedAttempts: number;
      failedAttempts: number;
      nextAttemptAllowedAt: Date | null;
    }>;

export type ReserveCredentialDto = Readonly<{
  /**
   * Which saga the reservation belongs to. Only a `signup` coordinator
   * enqueues `resume-signup`; a `link` reservation is re-driven by the
   * User Data side's `resume-link` (`spec/async/index.md`).
   */
  saga: "signup" | "link";
  operationId: string;
  candidateUserId: string;
  callerToken: string;
  /** The canonical value; sealed inside the bucket, which alone holds the key. */
  canonical: string;
  passwordVerifier: string | null;
  reservedUntil: Date;
  coordinator:
    | Readonly<{ role: "coordinator"; locators: readonly MappingLocator[] }>
    | Readonly<{ role: "member"; coordinatorLocator: string }>;
}>;

export type CredentialRefDto = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  label: string;
  usableForLogin: boolean;
}>;

export type InitializeAccountDto = Readonly<{
  operationId: string;
  callerToken: string;
  /** One for a password signup; two (subject + address) for an SSO signup. */
  credentials: readonly CredentialRefDto[];
  locators: readonly MappingLocator[];
}>;

export type ConsumedResetTokenDto = Readonly<{
  userId: string;
  credentialId: string;
  coordinate: CredentialCoordinateDto;
  /** The credential holds a password verifier — the only kind a reset may change. */
  hasVerifier: boolean;
  changeAuthToken: string;
}>;

export type BeginCredentialChangeDto = Readonly<{
  operationId: string;
  /** Carried into the `resume-credential-change` payload; the bucket does not know the owner otherwise. */
  userId: string;
  pendingVerifier: string;
  origin: CredentialChangeOrigin;
  changeAuthToken: string | null;
}>;

export type ApplyCredentialChangeDto = Readonly<{
  credentialId: string;
  /** A reset completion advances `resetVersion` and revokes the connections of the previous one. */
  resetCompletion: boolean;
}>;

export type ApplyCredentialChangeResult = Readonly<{
  credentialVersion: number;
}>;

export type PromoteVerifierDto = Readonly<{
  operationId: string;
  credentialVersion: number;
}>;

export type BeginLinkDto = Readonly<{
  operationId: string;
  credentialId: string;
  locator: MappingLocator;
  /** The credential's label (the provider), kept on the record for `resume-link`. */
  label: string;
}>;

export type BeginLinkResult = Readonly<{ callerToken: string }>;

export type CompleteLinkDto = Readonly<{
  operationId: string;
  locator: CredentialLocatorDto;
}>;

export type OperationRefDto = Readonly<{ operationId: string }>;

export type BeginUnlinkDto = Readonly<{
  operationId: string;
  credentialId: string;
}>;

export type BeginUnlinkResult = Readonly<{
  locators: readonly CredentialLocatorDto[];
  callerToken: string;
}>;

export type DeleteMappingDto = Readonly<{
  userId: string;
  callerToken: string;
}>;

export type RecordSignupLocatorDto = Readonly<{
  operationId: string;
  locator: CredentialLocatorDto;
}>;

export type CurrentUserDto = Readonly<{
  userId: string;
  trashRetentionDays: number;
  credentials: readonly Readonly<{
    credentialId: string;
    kind: CredentialKind;
    label: string;
    usableForLogin: boolean;
  }>[];
  locators: readonly CredentialLocatorDto[];
}>;

/**
 * The usecases' entry to both Durable Object classes. Every face carries
 * primitives only — branded types do not survive structured clone — and the
 * value objects are rebuilt on the far side, which is the second validation
 * point. Deriving where a canonical lives is this side's job, because the
 * mapping key is distributed to the request Worker alone.
 */
export interface IdentityGateway {
  /**
   * `null` for an initialised Durable Object holding no account row. A
   * Durable Object that was never initialised answers
   * `SystemError(NotInitialized)`, passed through unchanged: only the
   * presentation's session check folds it into "no session".
   */
  readAccountState(userId: string): Promise<AccountState | null>;
  deriveCredentialLocator(
    kind: CredentialKind,
    canonical: string,
    credentialId: string,
  ): Promise<MappingLocator>;
  reserveCredential(
    locator: MappingLocator,
    input: ReserveCredentialDto,
  ): Promise<void>;
  initializeAccount(userId: string, input: InitializeAccountDto): Promise<void>;
  /** The coordinator's `saga_committed` mark, written once phase 2 returned. */
  commitSignupSaga(
    locator: MappingLocator,
    operationId: string,
  ): Promise<boolean>;
  activateReservation(
    locator: MappingLocator,
    operationId: string,
    userId: string,
  ): Promise<boolean>;
  recordSignupLocator(
    userId: string,
    input: RecordSignupLocatorDto,
  ): Promise<void>;
  /** Login row resolution: the only read that returns a verifier. */
  resolveLoginCredential(
    canonicalEmail: string,
  ): Promise<LoginCredentialDto | null>;
  recordAttemptOutcome(
    coordinate: CredentialCoordinateDto,
    outcome: AttemptOutcomeDto,
  ): Promise<void>;
  findCredentialLocator(
    userId: string,
    credentialId: string,
  ): Promise<CredentialLocatorDto | null>;
  readCurrentUser(userId: string): Promise<CurrentUserDto | null>;
  /** The whole request, in the bucket the canonical resolves to; nothing is answered. */
  requestPasswordReset(canonicalEmail: string): Promise<void>;
  /** Consumes the token in the bucket it names; `null` for malformed / unknown / expired / used. */
  consumeResetToken(token: string): Promise<ConsumedResetTokenDto | null>;
  /** Hands back a reservation this caller token holds; absent is success. */
  cancelReservation(
    locator: MappingLocator,
    callerToken: string,
  ): Promise<void>;
  beginCredentialChange(
    coordinate: CredentialCoordinateDto,
    dto: BeginCredentialChangeDto,
  ): Promise<boolean>;
  applyCredentialChange(
    userId: string,
    dto: ApplyCredentialChangeDto,
  ): Promise<ApplyCredentialChangeResult>;
  markCredentialChangeAdvanced(
    coordinate: CredentialCoordinateDto,
    operationId: string,
  ): Promise<boolean>;
  promoteVerifier(
    coordinate: CredentialCoordinateDto,
    dto: PromoteVerifierDto,
  ): Promise<boolean>;
  /** The row behind a coordinate, verifier included — the change-password read. */
  readCredentialForChange(
    coordinate: CredentialCoordinateDto,
  ): Promise<LoginCredentialDto | null>;
  resolveSsoIdentity(
    provider: string,
    providerSubject: string,
  ): Promise<LoginCredentialDto | null>;
  beginLink(userId: string, dto: BeginLinkDto): Promise<BeginLinkResult>;
  completeLink(userId: string, dto: CompleteLinkDto): Promise<void>;
  finishLink(userId: string, dto: OperationRefDto): Promise<void>;
  beginUnlink(userId: string, dto: BeginUnlinkDto): Promise<BeginUnlinkResult>;
  deleteMapping(
    coordinate: CredentialCoordinateDto,
    dto: DeleteMappingDto,
  ): Promise<void>;
  finishUnlink(userId: string, dto: OperationRefDto): Promise<void>;
  revokeAllAiClientConnections(userId: string): Promise<number>;
  /** S-ST-01: the setting plus the trash-wide `purge_after` recalculation and the wake-up. */
  changeTrashRetentionDays(
    userId: string,
    retentionDays: number,
  ): Promise<void>;
  /** Decrypts one canonical for its owner; `null` when the row is not that user's. */
  revealCanonical(
    coordinate: CredentialCoordinateDto,
    userId: string,
  ): Promise<string | null>;
}
