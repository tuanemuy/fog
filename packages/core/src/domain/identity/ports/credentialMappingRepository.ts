import type {
  CredentialId,
  Email,
  PasswordHash,
  SsoProvider,
  UserId,
} from "../valueObject";

export type CredentialKind = "email" | "sso";

/**
 * Where one credential's mapping row lives, as saved by a saga so that it can
 * name the row later without re-deriving anything. Same shape as the elements
 * of `operations.target_locators` and `credential_mappings.locators`.
 */
export type MappingLocator = Readonly<{
  credentialId: string;
  kind: CredentialKind;
  hmac: string;
  generation: number;
  bucketIndex: number;
}>;

/** `mapping` is the same opaque routing material as `CredentialLocator.mapping`. */
export type CredentialCoordinate = Readonly<{
  credentialId: CredentialId;
  kind: CredentialKind;
  mapping: string;
}>;

/** The three PII columns of `credential_mappings`; the nonce is its own item. */
export type SealedCanonical = Readonly<{
  ciphertext: string;
  encryptionGeneration: number;
  nonce: string;
}>;

export type CredentialChangeState = "pending" | "advanced";
export type CredentialChangeOrigin = "password-change" | "reset";

export type CredentialMapping = Readonly<{
  credentialId: CredentialId;
  /** `null` while the row is still a reservation. */
  userId: UserId | null;
  kind: CredentialKind;
  usableForLogin: boolean;
  credentialVersion: number;
  changeState: CredentialChangeState | null;
  changeOrigin: CredentialChangeOrigin | null;
  failedAttempts: number;
  nextAttemptAllowedAt: Date | null;
}>;

/**
 * A mapping row as it leaves the bucket. The verifier and the sealed canonical
 * ride along because verification happens outside the DO and decryption
 * outside the transaction; `CredentialMapping` itself stays PII-free.
 */
export type CredentialMappingRecord = CredentialMapping &
  Readonly<{
    passwordVerifier: PasswordHash | null;
    sealedCanonical: SealedCanonical;
  }>;

/**
 * The read contract as the domain states it. It is satisfied by a pair of
 * implementations — the request Worker derives the locator, the bucket's
 * {@link CredentialMappingReader} looks the row up — because neither side can
 * do both (`spec/domains/identity.md`, 契約を満たす実装の形).
 */
export interface CredentialMappingRepository {
  findByEmail(email: Email): CredentialMapping | null;
  findBySsoIdentity(
    provider: SsoProvider,
    providerSubject: string,
  ): CredentialMapping | null;
  findByCredentialId(credentialId: CredentialId): CredentialMapping | null;
}

/** The locator-keyed reads available inside one bucket. */
export interface CredentialMappingReader {
  findByLocator(
    kind: CredentialKind,
    mapping: string,
  ): CredentialMappingRecord | null;
  findByCredentialId(
    credentialId: CredentialId,
  ): CredentialMappingRecord | null;
}

export type ReservationRole =
  | Readonly<{ role: "coordinator"; locators: readonly MappingLocator[] }>
  | Readonly<{ role: "member"; coordinatorLocator: string }>;

export type ReserveCredentialParams = Readonly<{
  coordinate: CredentialCoordinate;
  operationId: string;
  candidateUserId: UserId;
  callerToken: string;
  sealedCanonical: SealedCanonical;
  /** `null` for the email reservation an SSO registration places. */
  passwordVerifier: PasswordHash | null;
  reservedUntil: Date;
  coordinator: ReservationRole;
}>;

export type ActivateReservationParams = Readonly<{
  coordinate: CredentialCoordinate;
  operationId: string;
  userId: UserId;
}>;

export type CommitSagaParams = Readonly<{
  coordinate: CredentialCoordinate;
  operationId: string;
}>;

export type CancelReservationParams = Readonly<{
  coordinate: CredentialCoordinate;
  callerToken: string;
}>;

/**
 * The procedure stages that write the mapping row. Each is one CAS statement
 * whose predicate uses `operation_id` / `change_state` / `status` /
 * `saga_committed` / `caller_token` / `credential_id` — never a generic OCC
 * `version`. `boolean` means "the CAS hit a row"; `void` means the answer is
 * deliberately not reported. The credential-change stages
 * (`beginCredentialChange` / `promoteVerifier` / `deleteMapping`) join this
 * interface with the password-reset slice.
 */
export interface CredentialMappingWriter {
  /** Loses to an existing live row with `ConflictError`; a re-send of the same operation converges. */
  reserveCredential(params: ReserveCredentialParams): void;
  /**
   * Writes the `saga_committed` mark on the row of that operation once the
   * account side has committed (registration phase 2 returned). The mark
   * is what keeps `sweep-reservations` off a `reserved` row whose account
   * already exists (`spec/recovery/index.md`, 予約 TTL の不等式), so it is
   * written by the coordinator as its own step, before activation — never
   * folded into `activateReservation`. `true` on a `reserved` or `active`
   * row of that operation; `false` when the row is gone or belongs to
   * another operation.
   */
  commitSaga(params: CommitSagaParams): boolean;
  /** Promotes the reservation of that operation to an active mapping. */
  activateReservation(params: ActivateReservationParams): boolean;
  /**
   * Removes the row the caller names by coordinate, bound by `callerToken` and
   * `credentialId`; deletes that credential's reset tokens in the same
   * transaction. Absent and mismatched are both "success".
   */
  cancelReservation(params: CancelReservationParams): void;
  /** Holds the new verifier as pending; login refuses both passwords from here. Invalidates the credential's unused reset tokens. */
  beginCredentialChange(params: BeginCredentialChangeParams): boolean;
  /** Records that the User Data side applied phase 2 (`pending` → `advanced`). */
  markCredentialChangeAdvanced(params: CredentialChangeParams): boolean;
  /** `advanced` + same operation only: the pending verifier becomes the one, versions align, the lockout resets. */
  promoteVerifier(params: PromoteVerifierParams): boolean;
  /** The row of this user, bound by the caller token, with its reset tokens. "Absent is success". */
  deleteMapping(params: DeleteMappingParams): void;
}

export type BeginCredentialChangeParams = Readonly<{
  coordinate: CredentialCoordinate;
  operationId: string;
  pendingVerifier: PasswordHash;
  origin: CredentialChangeOrigin;
  /** Required for `origin: "reset"`: the bearer `verifyAndConsume` minted. */
  changeAuthToken: string | null;
}>;

export type CredentialChangeParams = Readonly<{
  coordinate: CredentialCoordinate;
  operationId: string;
}>;

export type PromoteVerifierParams = CredentialChangeParams &
  Readonly<{ credentialVersion: number }>;

export type DeleteMappingParams = Readonly<{
  coordinate: CredentialCoordinate;
  userId: UserId;
  callerToken: string;
}>;

export type CredentialAttemptOutcome =
  | Readonly<{ outcome: "success" }>
  | Readonly<{
      outcome: "failure";
      /** The pre-decay value the caller computed from; the CAS witness. */
      observedFailedAttempts: number;
      failedAttempts: number;
      nextAttemptAllowedAt: Date | null;
    }>;

/**
 * The seventh write into the mapping row: how a verification went. Success
 * takes no values (the reset is fixed in the statement); failure values are
 * computed by the caller and written only when `observedFailedAttempts` still
 * matches the stored value — otherwise the row's own counter advances by one
 * and `nextAttemptAllowedAt` takes the later of stored and reported.
 */
export interface CredentialAttemptRecorder {
  recordAttemptOutcome(
    coordinate: CredentialCoordinate,
    outcome: CredentialAttemptOutcome,
  ): void;
}
