import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "./errorCode";

const EMAIL_MAX_LENGTH = 320;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const CLIENT_NAME_MAX_LENGTH = 100;
const DEFAULT_TRASH_RETENTION_DAYS = 30;

declare const userIdBrand: unique symbol;
declare const credentialIdBrand: unique symbol;
declare const emailBrand: unique symbol;
declare const plainPasswordBrand: unique symbol;
declare const passwordHashBrand: unique symbol;
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

/**
 * Identity of a credential, stable across storage schemes and key
 * generations. Minted by `IdGenerator`; never derived from an address or
 * from a key, which is what lets reachability checks compare it directly
 * while a routing-key rotation has two generations of rows live at once.
 *
 * A non-PII value: it is what the settings screen shows and what an unlink
 * request names.
 */
export type CredentialId = string & { readonly [credentialIdBrand]: true };

export const CredentialId = {
  create: (raw: string): CredentialId => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidCredentialId,
        "Invalid credential id",
      );
    }
    return trimmed as CredentialId;
  },
};

export type Email = string & { readonly [emailBrand]: true };

// Deliberately structural (`local@domain`, no whitespace) rather than a
// full RFC 5322 grammar: the authoritative check on an address is whether
// mail to it is delivered, and an over-strict pattern rejects valid
// addresses. Length is capped at the RFC 5321 path limit.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

const ASCII_MAX = 0x7f;

/**
 * Whether the string carries any code unit above `U+007F`.
 *
 * A loop rather than a regular expression: a character class spanning the
 * ASCII range has to name control characters, which the linter refuses in a
 * pattern — and rightly, since a raw control byte in a source file is exactly
 * the hazard the SSO separator is written as an escape to avoid.
 */
function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > ASCII_MAX) return true;
  }
  return false;
}

function invalidEmail(message: string): BusinessRuleError<IdentityErrorCode> {
  return new BusinessRuleError(IdentityErrorCode.InvalidEmail, message);
}

/**
 * `URL` is the only IDNA (punycode) implementation available in both workerd
 * and Node without a dependency. A domain the URL parser refuses is not a
 * domain mail can be delivered to either, so the failure is reported as an
 * invalid address rather than as a system fault.
 */
function toAsciiDomain(domain: string): string {
  let host: string;
  try {
    host = new URL(`http://${domain}`).hostname;
  } catch {
    throw invalidEmail("Invalid email address");
  }
  // Bracketed IPv6 literals come back wrapped; they are not domains that
  // punycode applies to, and the structural check has already passed.
  if (host.length === 0 || hasNonAscii(host)) {
    throw invalidEmail("Invalid email address");
  }
  return host;
}

export const Email = {
  /**
   * The single source of canonical addresses. Everything downstream — the
   * uniqueness authority in the Identity Directory, the routing HMAC, the
   * encrypted original — consumes the value produced here, so the order of
   * these steps is part of the contract:
   *
   * trim → structural check → split on the **last** `@` → reject a non-ASCII
   * local part → lowercase the local part → NFKC + lowercase + punycode the
   * domain → rejoin → re-check the length.
   *
   * **NFKC is applied to the domain only.** It folds compatibility-equivalent
   * characters, but an SMTP local part is opaque at the octet level:
   * `ａｂｃ@example.com` and `abc@example.com` are different mailboxes. Since
   * the canonical value is also what a reset mail is addressed to, folding the
   * local part would deliver A's reset link to B's mailbox — and signup has no
   * address-ownership check to catch it.
   *
   * A non-ASCII local part is therefore **rejected** instead: not normalising
   * and still accepting it would let `ａ` and `a` become two accounts. SMTPUTF8
   * is out of scope by design.
   *
   * Lowercasing the local part is kept as an explicit trade: the same three
   * arguments formally apply to it, but folding case matches how mail
   * providers actually behave, and distinguishing it produces the more
   * frequent harm (duplicate accounts the user cannot tell apart).
   */
  create: (raw: string): Email => {
    const trimmed = raw.trim();
    if (codePointLength(trimmed) > EMAIL_MAX_LENGTH) {
      throw invalidEmail(`Email exceeds maximum length (${EMAIL_MAX_LENGTH})`);
    }
    // Before normalisation: "split on the last `@`" is undefined without it.
    if (!EMAIL_PATTERN.test(trimmed)) {
      throw invalidEmail("Invalid email address");
    }

    const at = trimmed.lastIndexOf("@");
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);

    if (hasNonAscii(local)) {
      throw invalidEmail("Invalid email address");
    }

    const normalizedDomain = domain.normalize("NFKC").toLowerCase();
    const asciiDomain = hasNonAscii(normalizedDomain)
      ? toAsciiDomain(normalizedDomain)
      : normalizedDomain;

    const canonical = `${local.toLowerCase()}@${asciiDomain}`;
    // Punycode lengthens; an input that fit before the conversion can exceed
    // the limit after it, so the bound is checked on the converted value too.
    if (codePointLength(canonical) > EMAIL_MAX_LENGTH) {
      throw invalidEmail(`Email exceeds maximum length (${EMAIL_MAX_LENGTH})`);
    }
    if (!EMAIL_PATTERN.test(canonical)) {
      throw invalidEmail("Invalid email address");
    }
    return canonical as Email;
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
    if (raw.length === 0) {
      throw new BusinessRuleError(
        IdentityErrorCode.InvalidPasswordHash,
        "Password hash cannot be empty",
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

/**
 * Separator between the provider name and the SSO subject inside an SSO
 * canonical value.
 *
 * `SsoProvider` is a closed enumeration of ASCII names, so a `U+0000` can
 * never occur inside a provider name and the split point is unambiguous.
 *
 * Written as an escape, never as a raw NUL byte: a raw NUL makes `grep` treat
 * this file as binary and silently report zero matches, which breaks the
 * mechanical checks and the hand-off searches at the same time.
 */
const SSO_CANONICAL_SEPARATOR = "\u0000";

/**
 * The canonical value an SSO credential is keyed by — the input to the
 * routing HMAC, exactly as `Email.create`'s result is for an address.
 *
 * The provider name is lowercased; **the subject is only trimmed**. It is an
 * opaque value minted by the provider, and normalising it (NFKC, case folding)
 * would put our notion of sameness out of step with theirs.
 *
 * Deriving the bucket from this value belongs to the request Worker; the
 * Identity Directory only ever sees `(kind, hmac)` (ADR-016).
 */
export function ssoCanonical(
  provider: SsoProvider,
  providerSubject: string,
): string {
  const subject = providerSubject.trim();
  if (subject.length === 0) {
    throw new BusinessRuleError(
      IdentityErrorCode.InvalidSsoProviderSubject,
      "SSO provider subject cannot be empty",
    );
  }
  return `${provider.toLowerCase()}${SSO_CANONICAL_SEPARATOR}${subject}`;
}
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
