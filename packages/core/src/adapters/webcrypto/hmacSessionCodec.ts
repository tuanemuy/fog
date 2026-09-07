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

type Payload = Readonly<{ uid: string; exp: number; epoch: number }>;

function parsePayload(raw: string): Payload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const { uid, exp, epoch } = decoded as Record<string, unknown>;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  // A token minted before the generation was part of the payload has
  // nothing to compare against, so it is refused rather than defaulted —
  // the same `null` as every other rejection.
  if (typeof epoch !== "number" || !Number.isInteger(epoch)) return null;
  return { uid, exp, epoch };
}

/**
 * `SessionCodec` backed by an HMAC-SHA256 signature over a
 * `{ uid, exp, epoch }` payload, encoded as
 * `<payloadBase64url>.<signatureBase64url>`.
 *
 * **Not stateless, and deliberately so.** There is no session table, but
 * the token carries the session generation it was issued under and the
 * caller compares it against the account's current one — which is a read
 * on the request path, in the user's own Durable Object. That read is the
 * price of revocation: without it `advanceSessionEpoch` would move a
 * number nothing consults, and a password change could not end the
 * sessions it was meant to end. **The comparison is the caller's**
 * (`apps/web/app/presentation/currentUser.ts`); this codec still reads no
 * storage itself, so swapping it stays inside the composition root: this
 * file, the DI factory that calls {@link createHmacSessionCodec}
 * (`application/di/serverCloudflare.ts`), the `application/di/secrets.ts`
 * check that reads {@link MIN_SESSION_SECRET_LENGTH}, and the test
 * harnesses that build a codec directly.
 *
 * `ttlMs` still defaults to a week: the generation check ends every
 * session of an account at once, so the expiry is what bounds a single
 * stolen token whose account nobody has touched.
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
    async issue(
      userId: string,
      sessionEpoch: number,
      now: Date,
    ): Promise<string> {
      const payload = toBase64Url(
        encoder.encode(
          JSON.stringify({
            uid: userId,
            exp: now.getTime() + ttlMs,
            epoch: sessionEpoch,
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

    async verify(
      token: string,
      now: Date,
    ): Promise<{ userId: string; sessionEpoch: number } | null> {
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
      return { userId: payload.uid, sessionEpoch: payload.epoch };
    },
  };
}
