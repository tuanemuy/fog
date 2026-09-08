import { fromBase64Url, toBase64Url } from "./encoding";
import { MIN_SESSION_SECRET_LENGTH } from "./hmacSessionCodec";

/** Ten minutes: long enough for a consent screen, short enough that a leaked state is worthless. */
export const DEFAULT_SSO_STATE_TTL_MS = 10 * 60 * 1000;

/** The derivation label (PH-06 △-3): the state key is never the session key's bytes. */
export const SSO_STATE_KEY_LABEL = "fog:sso-state";

export type SsoIntent = "login" | "link";

export type SsoStatePayload = Readonly<{
  provider: string;
  intent: SsoIntent;
  /** Same-origin path the callback returns to after a login. */
  redirect: string | null;
  /** The page the flow started from (`/login`, `/signup`, `/settings`): where an error is shown. */
  origin: string;
  /** The account a `link` intent attaches to; `null` for a login. */
  userId: string | null;
}>;

export interface SsoStateCodec {
  issue(payload: SsoStatePayload, now: Date): Promise<string>;
  verify(state: string, now: Date): Promise<SsoStatePayload | null>;
}

type Wire = SsoStatePayload & Readonly<{ nonce: string; exp: number }>;

function parseWire(raw: string): Wire | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const { provider, intent, redirect, origin, userId, nonce, exp } =
    decoded as Record<string, unknown>;
  if (typeof provider !== "string" || provider.length === 0) return null;
  if (typeof origin !== "string" || !origin.startsWith("/")) return null;
  if (intent !== "login" && intent !== "link") return null;
  if (redirect !== null && typeof redirect !== "string") return null;
  if (userId !== null && typeof userId !== "string") return null;
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return { provider, intent, redirect, origin, userId, nonce, exp };
}

/**
 * The OAuth `state` parameter, signed with a key derived from
 * `SESSION_SECRET` by HMAC-SHA256 under {@link SSO_STATE_KEY_LABEL}
 * (PH-06 △-3): one secret to deploy, two keys that never coincide, and a
 * session token cannot verify a state nor the reverse. The encoding is
 * the session codec's, `<payload>.<signature>` base64url; every refusal
 * is the same `null`.
 */
export function createSsoStateCodec(options: {
  sessionSecret: string;
  ttlMs?: number;
}): SsoStateCodec {
  if (options.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `Session secret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }
  const ttlMs = options.ttlMs ?? DEFAULT_SSO_STATE_TTL_MS;
  const encoder = new TextEncoder();
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= (async () => {
      const root = await crypto.subtle.importKey(
        "raw",
        encoder.encode(options.sessionSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const derived = await crypto.subtle.sign(
        "HMAC",
        root,
        encoder.encode(SSO_STATE_KEY_LABEL),
      );
      return crypto.subtle.importKey(
        "raw",
        derived,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    })();
    return keyPromise;
  };

  return {
    async issue(payload, now) {
      const wire: Wire = {
        ...payload,
        nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
        exp: now.getTime() + ttlMs,
      };
      const body = toBase64Url(encoder.encode(JSON.stringify(wire)));
      const signature = await crypto.subtle.sign(
        "HMAC",
        await getKey(),
        encoder.encode(body),
      );
      return `${body}.${toBase64Url(new Uint8Array(signature))}`;
    },
    async verify(state, now) {
      const parts = state.split(".");
      const [body, signature] = parts;
      if (parts.length !== 2 || !body || !signature) return null;
      let valid: boolean;
      try {
        valid = await crypto.subtle.verify(
          "HMAC",
          await getKey(),
          fromBase64Url(signature) as BufferSource,
          encoder.encode(body),
        );
      } catch {
        return null;
      }
      if (!valid) return null;
      const wire = parseWire(body);
      if (wire === null || wire.exp <= now.getTime()) return null;
      const { nonce: _nonce, exp: _exp, ...payload } = wire;
      return payload;
    },
  };
}
