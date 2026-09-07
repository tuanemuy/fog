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

export type InitializeAccountDto = Readonly<{
  operationId: string;
  callerToken: string;
  credential: Readonly<{
    credentialId: string;
    kind: CredentialKind;
    label: string;
    usableForLogin: boolean;
  }>;
  locators: readonly MappingLocator[];
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
  /** `null` for a Durable Object that was never initialised as well as for a missing row. */
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
  /** Decrypts one canonical for its owner; `null` when the row is not that user's. */
  revealCanonical(
    coordinate: CredentialCoordinateDto,
    userId: string,
  ): Promise<string | null>;
}
