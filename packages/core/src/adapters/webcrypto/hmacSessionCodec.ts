import type { SessionCodec } from "@repo/core/application/ports/sessionCodec";
import { fromBase64Url, toBase64Url } from "./encoding";

/** Seven days — short enough to bound a stateless token's blast radius. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Floor for the HMAC key length, asserted by the factory below.
 *
 * A shorter key than the hash's block-equivalent output buys nothing:
 * HMAC-SHA256 forgeries cost the key's entropy, not the payload's. This is
 * the invariant of the construction boundary itself, so paths that build
 * the codec directly (tests, a future app package) cannot skip it.
 *
 * `application/di/secrets.ts` imports it rather than restating it, so this
 * algorithm-specific floor is also what
 * `SESSION_SECRET` is checked against at request-config time. That import
 * is the only reader of this constant outside this file in shipped code,
 * and replacing the codec means replacing it too.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

export type HmacSessionCodecOptions = Readonly<{
  secret: string;
  ttlMs?: number;
}>;

type Payload = Readonly<{ uid: string; exp: number }>;

function parsePayload(raw: string): Payload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const { uid, exp } = decoded as Record<string, unknown>;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  return { uid, exp };
}

/**
 * `SessionCodec` backed by an HMAC-SHA256 signature over a `{ uid, exp }`
 * payload, encoded as `<payloadBase64url>.<signatureBase64url>`.
 *
 * Stateless by design: no session table, no read
 * on the request path, one implementation across all four runtimes. The
 * cost is that a token cannot be revoked server-side before `exp` —
 * acceptable while the product has no "sign out everywhere" requirement,
 * and the reason `ttlMs` defaults to a week rather than months. Swapping in
 * a table-backed codec later stays inside the composition root: this file,
 * the four DI factories that call {@link createHmacSessionCodec}
 * (`application/di/server{Node,Cloudflare,Aws,Gcp}.ts`), the
 * `application/di/secrets.ts` check that reads
 * {@link MIN_SESSION_SECRET_LENGTH}, and the test harnesses that build a
 * codec directly — callers of the port see nothing.
 *
 * Verification goes through `crypto.subtle.verify`, which compares the
 * MAC in constant time. Every rejection path — malformed token, bad
 * signature, expired payload — returns `null`; nothing about *why* a
 * token was refused reaches the caller.
 *
 * @throws if `secret` is shorter than {@link MIN_SESSION_SECRET_LENGTH}.
 */
export function createHmacSessionCodec(
  options: HmacSessionCodecOptions,
): SessionCodec {
  if (options.secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `Session secret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }

  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const encoder = new TextEncoder();

  // Shared by every call on this codec instance, which in the shipped
  // wiring means the calls of a single request: the DI factories build a
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
    async issue(userId: string, now: Date): Promise<string> {
      const payload = toBase64Url(
        encoder.encode(
          JSON.stringify({
            uid: userId,
            exp: now.getTime() + ttlMs,
          } satisfies Payload),
        ),
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        await getKey(),
        encoder.encode(payload),
      );
      return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
    },

    async verify(token: string, now: Date): Promise<{ userId: string } | null> {
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

      const payload = parsePayload(payloadPart);
      if (!payload || payload.exp <= now.getTime()) return null;
      return { userId: payload.uid };
    },
  };
}
