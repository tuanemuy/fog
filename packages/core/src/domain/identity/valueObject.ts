import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "./errorCode";

const EMAIL_MAX_LENGTH = 320;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const PASSWORD_HASH_MAX_BYTES = 2048;
const CLIENT_NAME_MAX_LENGTH = 100;
const DEFAULT_TRASH_RETENTION_DAYS = 30;

declare const userIdBrand: unique symbol;
declare const emailBrand: unique symbol;
declare const plainPasswordBrand: unique symbol;
declare const passwordHashBrand: unique symbol;
declare const ssoSubjectBrand: unique symbol;
declare const aiClientConnectionIdBrand: unique symbol;
declare const clientNameBrand: unique symbol;
declare const trashRetentionDaysBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: true };

// The domain treats ids as opaque, non-empty strings. Id format (UUIDv7
// here) belongs to `IdGenerator` and is verified by storage adapters on
// rehydration, so the generator stays swappable.
export const UserId = {
  create: (raw: string): UserId => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidUserId,
        "Invalid user id",
      );
    }
    return trimmed as UserId;
  },
};

export type Email = string & { readonly [emailBrand]: true };

// Deliberately structural (`local@domain`, no whitespace) rather than a
// full RFC 5322 grammar: the authoritative check on an address is whether
// mail to it is delivered, and an over-strict pattern rejects valid
// addresses. Length is capped at the RFC 5321 path limit.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export const Email = {
  create: (raw: string): Email => {
    const normalized = raw.trim().toLowerCase();
    if (codePointLength(normalized) > EMAIL_MAX_LENGTH) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidEmail,
        `Email exceeds maximum length (${EMAIL_MAX_LENGTH})`,
      );
    }
    if (!EMAIL_PATTERN.test(normalized)) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidEmail,
        "Invalid email address",
      );
    }
    return normalized as Email;
  },
};

/**
 * A password as typed by the user, before hashing.
 *
 * Never log, never put in an event payload, never persist: `users` has no
 * plaintext column, and the entity factories take a `PasswordHash`. Being a
 * branded `string` (the convention every identity VO follows) there is no
 * `toString` / `toJSON` to override, so this rule is held by tests and
 * review rather than by the type.
 *
 * Not trimmed: leading / trailing whitespace is part of what the user typed
 * and must survive to `PasswordHasher.hash` verbatim.
 */
export type PlainPassword = string & { readonly [plainPasswordBrand]: true };

export const PlainPassword = {
  create: (raw: string): PlainPassword => {
    const length = codePointLength(raw);
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
      throw new BusinessRuleError(
        IdentityErrorCode.PasswordTooWeak,
        `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
    return raw as PlainPassword;
  },
};

/**
 * Hashed password. The algorithm and its encoding are owned by the
 * `PasswordHasher` adapter; the domain holds an opaque non-empty string and
 * never compares it directly — comparison goes through
 * `PasswordHasher.verify` so it stays timing-safe.
 */
export type PasswordHash = string & { readonly [passwordHashBrand]: true };

export const PasswordHash = {
  create: (raw: string): PasswordHash => {
    if (
      raw.length === 0 ||
      new TextEncoder().encode(raw).byteLength > PASSWORD_HASH_MAX_BYTES
    ) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidPasswordHash,
        "Password hash is malformed",
      );
    }
    return raw as PasswordHash;
  },
};

export type SsoProvider = "google" | "apple";

export const SsoProvider = {
  create: (raw: string): SsoProvider => {
    if (raw !== "google" && raw !== "apple") {
      throw new BusinessRuleError(
        IdentityErrorCode.UnsupportedSsoProvider,
        `Unsupported SSO provider: ${raw}`,
      );
    }
    return raw;
  },
};

export type SsoSubject = string & { readonly [ssoSubjectBrand]: true };

export const SsoSubject = {
  create: (raw: string): SsoSubject => {
    const normalized = raw.normalize("NFKC").trim();
    if (
      normalized.length === 0 ||
      new TextEncoder().encode(normalized).byteLength > 512
    ) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidSsoProviderSubject,
        "Invalid SSO subject",
      );
    }
    return normalized as SsoSubject;
  },
};

export type AiClientConnectionId = string & {
  readonly [aiClientConnectionIdBrand]: true;
};

export const AiClientConnectionId = {
  create: (raw: string): AiClientConnectionId => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidAiClientConnectionId,
        "Invalid AI client connection id",
      );
    }
    return trimmed as AiClientConnectionId;
  },
};

export type ClientName = string & { readonly [clientNameBrand]: true };

export const ClientName = {
  create: (raw: string): ClientName => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidClientName,
        "Client name cannot be empty",
      );
    }
    if (codePointLength(trimmed) > CLIENT_NAME_MAX_LENGTH) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidClientName,
        `Client name exceeds maximum length (${CLIENT_NAME_MAX_LENGTH})`,
      );
    }
    return trimmed as ClientName;
  },
};

/**
 * Days a soft-deleted item is kept before hard deletion. Defined here and
 * only here — the trash domain reads it from identity rather than
 * re-declaring the concept (dependency runs trash → identity).
 */
export type TrashRetentionDays = number & {
  readonly [trashRetentionDaysBrand]: true;
};

export const TrashRetentionDays = {
  create: (raw: number): TrashRetentionDays => {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidTrashRetentionDays,
        `Trash retention days must be an integer >= 1: ${raw}`,
      );
    }
    return raw as TrashRetentionDays;
  },
  default: (): TrashRetentionDays =>
    DEFAULT_TRASH_RETENTION_DAYS as TrashRetentionDays,
};

export type UserActor = Readonly<{
  kind: "user";
  userId: UserId;
}>;

export type AiClientActor = Readonly<{
  kind: "aiClient";
  userId: UserId;
  connectionId: AiClientConnectionId;
  clientName: ClientName;
}>;

/**
 * Who performed an operation. Cross-cutting: every domain that records
 * revisions stores one, and identity is the single place it is defined.
 *
 * `AiClientActor` carries `clientName` as a snapshot so revision history can
 * render "which AI" without re-reading the connection — the record stays
 * truthful after the connection is revoked or renamed.
 */
export type Actor = UserActor | AiClientActor;

export const Actor = {
  user: (userId: UserId): UserActor => ({ kind: "user", userId }),
  aiClient: (
    userId: UserId,
    connectionId: AiClientConnectionId,
    clientName: ClientName,
  ): AiClientActor => ({ kind: "aiClient", userId, connectionId, clientName }),
};
