/**
 * Encodes bytes as standard (padded) base64.
 *
 * This is the wire format of the stored password hash's salt and derived
 * key, so changing it invalidates every persisted hash.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decodes standard base64 back to bytes, throwing on input `atob` refuses.
 *
 * Decoding is *forgiving* in the same way `atob` is: embedded whitespace
 * and missing padding are accepted. Treat the byte output as the value,
 * never the string that produced it.
 */
export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encodes bytes as unpadded base64url (RFC 4648 §5) — the alphabet the
 * session token uses so it survives a cookie value untouched.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decodes base64url back to bytes, re-adding the padding this module's
 * encoder strips.
 *
 * **The decoding is not canonical.** Standard-base64 `+` / `/` survive the
 * substitution below and decode to the same bytes as their base64url
 * spellings, so several distinct strings yield one byte sequence. That is
 * harmless for signature verification (the bytes are what gets compared),
 * but it means a token string must never be treated as a canonical
 * identity: do not compare, index or deduplicate on the encoded form.
 *
 * Acceptance is *narrower* than `atob`'s, not wider: padding is computed
 * from the length of the input, so embedded whitespace and redundant `=`
 * push the result off a multiple of four and `atob` refuses it, even
 * though `atob` would have tolerated either on its own.
 */
export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
}

/**
 * Compares two byte sequences without short-circuiting on the first
 * mismatch, so the running time reveals nothing about how much of a
 * candidate secret was correct. Length inequality is not secret here
 * (the encoding fixes it), so it returns early.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
