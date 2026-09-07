import { fromBase64, toBase64 } from "@repo/core/adapters/webcrypto/encoding";
import type {
  CredentialKind,
  SealedCanonical,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import {
  activeKey,
  type EncryptionKeyEntry,
  type EncryptionKeyring,
  keyForGeneration,
} from "./keyring";

/** AES-GCM's nominal nonce width. A fresh one is drawn for every write. */
const NONCE_BYTES = 12;

/**
 * What the ciphertext is bound to.
 *
 * `hmac` is deliberately **not** part of it: transferring a row to a new
 * mapping-key generation moves the three ciphertext columns verbatim and
 * re-derives the HMAC, so binding to the HMAC would make every
 * transferred row undecryptable. Re-encryption is a separate operation
 * with its own generation.
 */
export type CanonicalAad = Readonly<{
  kind: CredentialKind;
  credentialId: string;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function aadBytes(aad: CanonicalAad, encryptionGeneration: number): Uint8Array {
  return encoder.encode(
    `${aad.kind}\u0000${aad.credentialId}\u0000${encryptionGeneration}`,
  );
}

// The secret is a free-form string (`openssl rand -base64 48`), and
// AES-256 needs exactly 32 bytes, so the key material is the SHA-256 of
// the secret's UTF-8 bytes. That is a length fix, not a stretch: the
// floor `createEncryptionKeyring` enforces is what supplies the entropy.
async function importKey(entry: EncryptionKeyEntry): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(entry.key),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypts a canonical credential value under the keyring's active
 * generation.
 *
 * **The email encryption keyring is distributed to the state Worker
 * alone**, so this runs inside the Identity Directory Durable Object —
 * and, being asynchronous, *outside* its transaction. The write path is
 * "seal at the RPC entry, then hand the three primitives into
 * `runUnitOfWork`", never "seal while the transaction is open".
 *
 * **A fresh nonce is drawn per call** and returned as its own field. It
 * is never concatenated onto the ciphertext and never reused — reusing
 * one under the same key is what makes AES-GCM leak the plaintexts.
 */
export async function sealCanonical(
  keyring: EncryptionKeyring,
  aad: CanonicalAad,
  canonical: string,
): Promise<SealedCanonical> {
  const entry = activeKey(keyring);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: aadBytes(aad, entry.generation) as BufferSource,
    },
    await importKey(entry),
    encoder.encode(canonical),
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    encryptionGeneration: entry.generation,
    nonce: toBase64(nonce),
  };
}

/**
 * Decrypts one stored canonical value, or returns `null` if it cannot be
 * read back — a retired generation, a tampered row, an AAD that does not
 * match the row it was read from.
 *
 * `null` rather than a thrown error because every failure here means the
 * same thing to the caller (this row's canonical value is not
 * recoverable) and the caller is the one holding the context to say so.
 *
 * **Reads are two-phase**: the transaction reads the row and closes, and
 * decryption happens after it. Nothing in this slice needs a decrypted
 * value back inside the transaction that read it.
 *
 * The plaintext leaves the Durable Object through exactly one response —
 * the self-referential lookup that renders the signed-in user's own
 * address — and is persisted nowhere.
 */
export async function openCanonical(
  keyring: EncryptionKeyring,
  aad: CanonicalAad,
  sealed: SealedCanonical,
): Promise<string | null> {
  const entry = keyForGeneration(keyring, sealed.encryptionGeneration);
  if (!entry) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(sealed.nonce) as BufferSource,
        additionalData: aadBytes(aad, entry.generation) as BufferSource,
      },
      await importKey(entry),
      fromBase64(sealed.ciphertext) as BufferSource,
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}
