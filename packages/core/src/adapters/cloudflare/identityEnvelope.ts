import type { DirectoryKeyring } from "./identityRouting";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VERSION = "v1";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`fog:identity-envelope:v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptIdentityValue(
  value: string,
  keyring: DirectoryKeyring,
  purpose: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(purpose),
    },
    await key(keyring.active.secret),
    encoder.encode(value),
  );
  return [
    VERSION,
    keyring.active.generation,
    base64Url(iv),
    base64Url(new Uint8Array(ciphertext)),
  ].join(".");
}

export async function decryptIdentityValue(
  envelope: string,
  keyring: DirectoryKeyring,
  purpose: string,
): Promise<string> {
  const [version, generation, encodedIv, encodedCiphertext, ...extra] =
    envelope.split(".");
  if (
    version !== VERSION ||
    !generation ||
    !encodedIv ||
    !encodedCiphertext ||
    extra.length > 0
  ) {
    throw new Error("IDENTITY_ENVELOPE_INVALID");
  }
  const candidate =
    keyring.active.generation === generation
      ? keyring.active
      : keyring.previous?.generation === generation
        ? keyring.previous
        : null;
  if (!candidate) throw new Error("IDENTITY_ENVELOPE_KEY_UNAVAILABLE");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(encodedIv) as BufferSource,
        additionalData: encoder.encode(purpose),
      },
      await key(candidate.secret),
      fromBase64Url(encodedCiphertext) as BufferSource,
    );
    return decoder.decode(plaintext);
  } catch (error) {
    throw new Error("IDENTITY_ENVELOPE_AUTHENTICATION_FAILED", {
      cause: error,
    });
  }
}
