import type { SessionCodec } from "@repo/core/application/ports/sessionCodec";
import { MIN_SESSION_SECRET_LENGTH } from "@repo/core/lib/secretLengths";
import { fromBase64Url, toBase64Url } from "./encoding";

export { MIN_SESSION_SECRET_LENGTH };

/** Seven days — short enough to bound a stateless token's blast radius. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The audience tag. Session tokens and AI client tokens are signed with
 * different keys *and* carry different `typ` values, so neither a key mix-up
 * nor a signing-key reuse can make one pass as the other.
 */
export type TokenType = "session" | "aiClient";

export type HmacTokenCodecOptions = Readonly<{
  secret: string;
  typ: TokenType;
  ttlMs?: number;
}>;

export type TokenPayload = Readonly<{
  typ: string;
  uid: string;
  /** Session epoch at issue time. */
  ep: number;
  exp: number;
}>;

export interface HmacTokenCodec {
  issue(uid: string, ep: number, now: Date): Promise<string>;
  verify(token: string, now: Date): Promise<TokenPayload | null>;
}

/**
 * Rejects anything that is not exactly the expected shape.
 *
 * **A missing `typ` or `ep` is a rejection, not a default.** Treating an absent
 * `ep` as epoch 0 would let a token minted before epochs existed survive a
 * revocation that was supposed to kill it; the price of refusing is one
 * re-login for everyone, which is recoverable, and a session that outlives its
 * revocation is not.
 */
function parsePayload(
  raw: string,
  expectedTyp: TokenType,
): TokenPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const { typ, uid, ep, exp } = decoded as Record<string, unknown>;
  if (typeof typ !== "string" || typ !== expectedTyp) return null;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof ep !== "number" || !Number.isInteger(ep) || ep < 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return { typ, uid, ep, exp };
}

/**
 * HMAC-SHA256 over a `{ typ, uid, ep, exp }` payload, encoded as
 * `<payloadBase64url>.<signatureBase64url>`.
 *
 * Stateless by design: no session table, no read on the request path. What that
 * costs is server-side revocation before `exp` — which the `ep` field is what
 * buys back, since the Durable Object compares it against the account's current
 * epoch on every protected call.
 *
 * Verification goes through `crypto.subtle.verify`, which compares the MAC in
 * constant time. Every rejection path returns `null`; nothing about *why* a
 * token was refused reaches the caller.
 *
 * @throws if `secret` is shorter than {@link MIN_SESSION_SECRET_LENGTH}.
 */
export function createHmacTokenCodec(
  options: HmacTokenCodecOptions,
): HmacTokenCodec {
  if (options.secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `Token secret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }

  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const encoder = new TextEncoder();

  // Shared by every call on this codec instance, which in the shipped
  // wiring means the calls of a single request: the DI factory builds a
  // container per request, so this collapses `issue` + `verify` within
  // one hit rather than amortising `importKey` across the process.
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle.importKey(
      "raw",
      encoder.encode(options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return keyPromise;
  };

  return {
    async issue(uid: string, ep: number, now: Date): Promise<string> {
      const payload = toBase64Url(
        encoder.encode(
          JSON.stringify({
            typ: options.typ,
            uid,
            ep,
            exp: now.getTime() + ttlMs,
          } satisfies TokenPayload),
        ),
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        await getKey(),
        encoder.encode(payload),
      );
      return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
    },

    async verify(token: string, now: Date): Promise<TokenPayload | null> {
      const parts = token.split(".");
      const [payloadPart, signaturePart] = parts;
      if (parts.length !== 2 || !payloadPart || !signaturePart) return null;

      let valid: boolean;
      try {
        valid = await crypto.subtle.verify(
          "HMAC",
          await getKey(),
          fromBase64Url(signaturePart) as BufferSource,
          encoder.encode(payloadPart),
        );
      } catch {
        return null;
      }
      if (!valid) return null;

      const payload = parsePayload(payloadPart, options.typ);
      if (!payload || payload.exp <= now.getTime()) return null;
      return payload;
    },
  };
}

export type HmacSessionCodecOptions = Readonly<{
  secret: string;
  ttlMs?: number;
}>;

/** The session-shaped view of {@link createHmacTokenCodec}. */
export function createHmacSessionCodec(
  options: HmacSessionCodecOptions,
): SessionCodec {
  const codec = createHmacTokenCodec({ ...options, typ: "session" });
  return {
    issue: (userId, epoch, now) => codec.issue(userId, epoch, now),
    async verify(token, now) {
      const payload = await codec.verify(token, now);
      return payload === null
        ? null
        : { userId: payload.uid, epoch: payload.ep };
    },
  };
}
