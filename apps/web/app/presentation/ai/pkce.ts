const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 7636 S256: base64url(SHA-256(verifier)), compared against the challenge. */
export async function pkceChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** 43–128 characters of the unreserved set (RFC 7636 §4.1). */
export function isPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** The challenge is 43 characters of base64url for S256. */
export function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
