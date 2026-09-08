/**
 * One deployed secret, many keys: each use derives its own HMAC key as
 * HMAC-SHA256(secret, label). A value signed for one use never verifies
 * under another's key, and no use ever holds the secret's own bytes as
 * its key (PH-06 △-3, PH-07 △-1).
 */
export function deriveHmacKey(
  secret: string,
  label: string,
): () => Promise<CryptoKey> {
  const encoder = new TextEncoder();
  let keyPromise: Promise<CryptoKey> | null = null;
  return () => {
    keyPromise ??= (async () => {
      const root = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const derived = await crypto.subtle.sign(
        "HMAC",
        root,
        encoder.encode(label),
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
}
