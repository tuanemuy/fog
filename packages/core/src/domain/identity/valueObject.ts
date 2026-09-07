import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import { IdentityErrorCode } from "./errorCode";

declare const userIdBrand: unique symbol;
declare const credentialIdBrand: unique symbol;
declare const aiClientConnectionIdBrand: unique symbol;
declare const emailBrand: unique symbol;
declare const plainPasswordBrand: unique symbol;
declare const passwordHashBrand: unique symbol;
declare const clientNameBrand: unique symbol;
declare const trashRetentionDaysBrand: unique symbol;

function fail(code: IdentityErrorCode, message: string): never {
  throw new BusinessRuleError<IdentityErrorCode>(code, message);
}

function nonEmptyId<T>(raw: string, code: IdentityErrorCode, label: string): T {
  const trimmed = raw.trim();
  if (trimmed.length === 0) fail(code, `Invalid ${label}`);
  return trimmed as T;
}

/** Opaque, non-empty. The format (UUIDv7) is the `IdGenerator`'s to validate. */
export type UserId = string & { readonly [userIdBrand]: true };
export const UserId = {
  create: (raw: string): UserId =>
    nonEmptyId<UserId>(raw, IdentityErrorCode.InvalidUserId, "user id"),
};

/**
 * Identity of a credential that survives storage-scheme and key-generation
 * changes. Minted by `IdGenerator`, never derived from the email or a key.
 */
export type CredentialId = string & { readonly [credentialIdBrand]: true };
export const CredentialId = {
  create: (raw: string): CredentialId =>
    nonEmptyId<CredentialId>(
      raw,
      IdentityErrorCode.InvalidCredentialId,
      "credential id",
    ),
};

export type AiClientConnectionId = string & {
  readonly [aiClientConnectionIdBrand]: true;
};
export const AiClientConnectionId = {
  create: (raw: string): AiClientConnectionId =>
    nonEmptyId<AiClientConnectionId>(
      raw,
      IdentityErrorCode.InvalidAiClientConnectionId,
      "AI client connection id",
    ),
};

const EMAIL_MAX_LENGTH = 320;

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) >= 0x80) return true;
  }
  return false;
}

function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalidEmail(): never {
  return fail(IdentityErrorCode.InvalidEmail, "Invalid email address");
}

/**
 * Maps a domain label to its ASCII (IDNA) form. The WHATWG URL parser is the
 * only UTS46 implementation the runtime ships, so the domain rides through it
 * as a host; a value it refuses as a host is not a mail domain either.
 */
function toAsciiDomain(domain: string): string {
  try {
    const url = new URL(`http://${domain}/`);
    if (url.username !== "" || url.password !== "" || url.port !== "") {
      invalidEmail();
    }
    return url.hostname;
  } catch {
    return invalidEmail();
  }
}

/**
 * Canonical email address. This factory is the single source of
 * canonicalisation: uniqueness on the Identity Directory side and the
 * reachability check both take its output and nothing else.
 *
 * The eight ordered steps are `spec/domains/identity.md`'s. The local part is
 * lowercased but never NFKC-folded and must be ASCII (no SMTPUTF8); the domain
 * is NFKC-folded, lowercased, converted to its IDNA ASCII form when non-ASCII,
 * then stripped of exactly one trailing dot. The 320-character bound is
 * checked before and after normalisation because IDNA conversion can lengthen
 * the string.
 */
export type Email = string & { readonly [emailBrand]: true };
export const Email = {
  create: (raw: string): Email => {
    const trimmed = raw.trim();
    if (codePointLength(trimmed) > EMAIL_MAX_LENGTH) invalidEmail();
    const at = trimmed.lastIndexOf("@");
    if (at <= 0 || at === trimmed.length - 1) invalidEmail();
    const rawLocal = trimmed.slice(0, at);
    const rawDomain = trimmed.slice(at + 1);
    if (hasNonAscii(rawLocal) || hasControlOrSpace(rawLocal)) invalidEmail();
    const local = rawLocal.toLowerCase();

    let domain = rawDomain.normalize("NFKC").toLowerCase();
    if (hasControlOrSpace(domain)) invalidEmail();
    if (hasNonAscii(domain)) domain = toAsciiDomain(domain);
    if (domain.endsWith(".")) domain = domain.slice(0, -1);
    if (domain.length === 0 || domain.endsWith(".")) invalidEmail();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain)) invalidEmail();

    const canonical = `${local}@${domain}`;
    if (codePointLength(canonical) > EMAIL_MAX_LENGTH) invalidEmail();
    return canonical as Email;
  },
};

export const PLAIN_PASSWORD_MIN_CODE_POINTS = 8;
export const PLAIN_PASSWORD_MAX_CODE_POINTS = 128;

/**
 * The password as typed. Never logged and never persisted — only the
 * `PasswordHasher` port consumes it.
 */
export type PlainPassword = string & { readonly [plainPasswordBrand]: true };
export const PlainPassword = {
  create: (raw: string): PlainPassword => {
    const length = codePointLength(raw);
    if (
      length < PLAIN_PASSWORD_MIN_CODE_POINTS ||
      length > PLAIN_PASSWORD_MAX_CODE_POINTS
    ) {
      fail(
        IdentityErrorCode.PasswordTooWeak,
        `Password must be between ${PLAIN_PASSWORD_MIN_CODE_POINTS} and ${PLAIN_PASSWORD_MAX_CODE_POINTS} characters`,
      );
    }
    return raw as PlainPassword;
  },
};

/** Opaque verifier. Compared only through `PasswordHasher.verify`. */
export type PasswordHash = string & { readonly [passwordHashBrand]: true };
export const PasswordHash = {
  create: (raw: string): PasswordHash =>
    nonEmptyId<PasswordHash>(
      raw,
      IdentityErrorCode.InvalidPasswordHash,
      "password hash",
    ),
};

export type SsoProvider = "google" | "apple";
const SSO_PROVIDERS: readonly SsoProvider[] = ["google", "apple"];
export const SsoProvider = {
  create: (raw: string): SsoProvider => {
    if (!(SSO_PROVIDERS as readonly string[]).includes(raw)) {
      fail(
        IdentityErrorCode.UnsupportedSsoProvider,
        "Unsupported SSO provider",
      );
    }
    return raw as SsoProvider;
  },
};

export const CLIENT_NAME_MAX_CODE_POINTS = 100;

export type ClientName = string & { readonly [clientNameBrand]: true };
export const ClientName = {
  create: (raw: string): ClientName => {
    const trimmed = raw.trim();
    if (
      trimmed.length === 0 ||
      codePointLength(trimmed) > CLIENT_NAME_MAX_CODE_POINTS
    ) {
      fail(IdentityErrorCode.InvalidClientName, "Invalid client name");
    }
    return trimmed as ClientName;
  },
};

const TRASH_RETENTION_DAYS_DEFAULT = 30;

/**
 * Days a trashed item stays recoverable. Defined only here; the trash domain
 * reads it and defines no retention value object of its own.
 */
export type TrashRetentionDays = number & {
  readonly [trashRetentionDaysBrand]: true;
};
export const TrashRetentionDays = {
  create: (raw: number): TrashRetentionDays => {
    if (!Number.isInteger(raw) || raw < 1) {
      fail(
        IdentityErrorCode.InvalidTrashRetentionDays,
        "Trash retention days must be an integer of at least 1",
      );
    }
    return raw as TrashRetentionDays;
  },
  default: (): TrashRetentionDays =>
    TRASH_RETENTION_DAYS_DEFAULT as TrashRetentionDays,
};

export type UserActor = Readonly<{ kind: "user"; userId: UserId }>;
export type AiClientActor = Readonly<{
  kind: "aiClient";
  userId: UserId;
  connectionId: AiClientConnectionId;
  /** Snapshot so revision history renders without re-reading the connection. */
  clientName: ClientName;
}>;
export type Actor = UserActor | AiClientActor;

export const Actor = {
  user: (userId: UserId): UserActor => ({ kind: "user", userId }),
  aiClient: (
    userId: UserId,
    connectionId: AiClientConnectionId,
    clientName: ClientName,
  ): AiClientActor => ({ kind: "aiClient", userId, connectionId, clientName }),
};

export type AiPermission = "read" | "write";
export type HumanPermission = AiPermission | "hardDelete" | "trash" | "history";
export type HumanScope = Readonly<{ type: "human" }>;
export type AiScope = Readonly<{ type: "ai" }>;
export type TokenScope = HumanScope | AiScope;

const AI_PERMISSIONS: ReadonlySet<HumanPermission> = new Set<HumanPermission>([
  "read",
  "write",
]);

/**
 * The permission asymmetry between a human session and an AI token. The type
 * makes the AI side a strict subset; `allows` is the runtime mirror for the
 * authorization middleware.
 */
export const TokenScope = {
  human: (): HumanScope => ({ type: "human" }),
  ai: (): AiScope => ({ type: "ai" }),
  allows: (scope: TokenScope, permission: HumanPermission): boolean =>
    scope.type === "human" || AI_PERMISSIONS.has(permission),
};
