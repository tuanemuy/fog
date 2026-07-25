import type { SessionCodec } from "@repo/core/application/ports/sessionCodec";
import { fromBase64Url, toBase64Url } from "./encoding";

/** Seven days — short enough to bound a stateless token's blast radius. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Stateless by design (ADR-002): no session table, no read on the request
 * path, one implementation across all four runtimes. The cost is that a
 * token cannot be revoked server-side before `exp` — acceptable while the
 * product has no "sign out everywhere" requirement, and the reason `ttlMs`
 * defaults to a week rather than months. Swapping in a table-backed codec
 * later is a one-file change because callers only see this port.
 *
 * Verification goes through `crypto.subtle.verify`, which compares the
 * MAC in constant time. Every rejection path — malformed token, bad
 * signature, expired payload — returns `null`; nothing about *why* a
 * token was refused reaches the caller.
 */
export function createHmacSessionCodec(
  options: HmacSessionCodecOptions,
): SessionCodec {
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const encoder = new TextEncoder();

  // Imported once and shared: `importKey` is async, and re-running it per
  // request would add a needless await to every authenticated hit.
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
