import type { Keyring } from "@repo/core/application/di/secrets";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { SealedCanonical } from "@repo/core/domain/identity/ports/credentialMappingStore";

/**
 * `credential_mappings.encrypted_canonical`.
 *
 * The raw address is the highest-value PII in the system, and HMAC routing is
 * one-way, so the bucket keeps a reversible copy under a key that only the
 * state Worker holds. AES-256-GCM, with a fresh 96-bit nonce per write kept in
 * its own column — concatenating it onto the ciphertext would make the
 * re-encryption job's parsing rule generation-dependent.
 *
 * **The AAD binds `(kind, credentialId, encryptionGeneration)` and deliberately
 * omits `hmac`.** Binding it would make a routing-key rotation, which moves
 * rows between buckets and therefore changes `hmac`, silently un-decryptable —
 * and since a failed decryption fails closed, the damage would only surface at
 * the first reset request after the rotation. `credentialId` already catches
 * the attack the AAD is for (swapping one row's ciphertext onto another).
 *
 * **Both sides live here.** The writer is {@link sealCanonical}, called from the
 * `reserve-credential` RPC entry *before* it opens its transaction: WebCrypto is
 * asynchronous and a `run()` callback is not, so the only place a bucket can
 * encrypt is the entry point, which is asynchronous by construction. The reader
 * is {@link decryptCanonical}, called by the `send-mail` job and later by
 * `rotate-encryption`.
 */

const NONCE_BYTES = 12;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored ciphertext is not hex",
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** The keyring entry a row declares, never simply the active one. */
function keyMaterial(keyring: Keyring, generation: number): string {
  const entry = keyring.entries.find(
    (candidate) => candidate.generation === generation,
  );
  if (entry === undefined) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      `No mail encryption key for generation ${generation}`,
    );
  }
  return entry.key;
}

/**
 * A 256-bit key from an arbitrary-length secret. The keyring carries text, and
 * AES-GCM needs exactly 32 bytes; hashing is the standard widening and keeps
 * the deployment free to set a passphrase of any length.
 */
async function importKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export type CanonicalAad = Readonly<{
  kind: string;
  credentialId: string;
  generation: number;
}>;

/**
 * The separator is written as an escape, never as a raw NUL byte — the rule
 * `SSO_CANONICAL_SEPARATOR` states, for the same reason: a raw NUL makes `grep`
 * treat this file as binary and report zero matches, so every mechanical check
 * over it fails silently. The bytes encoded are identical either way.
 */
function aadBytes(aad: CanonicalAad): Uint8Array<ArrayBuffer> {
  return copyBytes(
    new TextEncoder().encode(
      `${aad.kind}\u0000${aad.credentialId}\u0000${aad.generation}`,
    ),
  );
}

/**
 * WebCrypto's `BufferSource` insists on a view over a plain `ArrayBuffer`,
 * which neither `TextEncoder.encode` nor a hex decode is typed to guarantee.
 * One copy, in one place, beats a cast at each call site.
 */
function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.byteLength));
  bytes.set(value);
  return bytes;
}

export type EncryptedCanonical = Readonly<{
  ciphertext: string;
  nonce: string;
}>;

export async function encryptCanonical(
  keyring: Keyring,
  canonical: string,
  aad: CanonicalAad,
): Promise<EncryptedCanonical> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aadBytes(aad) },
    await importKey(keyMaterial(keyring, aad.generation)),
    new TextEncoder().encode(canonical),
  );
  return { ciphertext: toHex(new Uint8Array(sealed)), nonce: toHex(nonce) };
}

/**
 * Seals an address for the row that is about to be written, under the keyring's
 * **active** generation — the row records which one, so a rotation opens each
 * row with the key that closed it.
 *
 * Takes the keyring nullably and refuses loudly, the same shape `send-mail`
 * uses: a deployment that binds no key must not be able to write reservations
 * whose address can never be recovered, and "wrote NULL and carried on" is
 * exactly the silent version of that failure.
 */
export async function sealCanonical(
  keyring: Keyring | null,
  canonical: string,
  binding: Readonly<{ kind: string; credentialId: string }>,
): Promise<SealedCanonical> {
  if (keyring === null) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      "IDENTITY_MAIL_ENCRYPTION_KEY is not configured on the state Worker",
    );
  }
  const generation = keyring.entries[0]?.generation;
  if (generation === undefined) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      "IDENTITY_MAIL_ENCRYPTION_KEY declares no active generation",
    );
  }
  const sealed = await encryptCanonical(keyring, canonical, {
    kind: binding.kind,
    credentialId: binding.credentialId,
    generation,
  });
  return { ciphertext: sealed.ciphertext, generation, nonce: sealed.nonce };
}

/**
 * Fails closed. A ciphertext that will not open is drift the caller cannot
 * repair, and treating it as "no address on file" would turn a tampered row
 * into a silently unreachable account.
 */
export async function decryptCanonical(
  keyring: Keyring,
  sealed: EncryptedCanonical,
  aad: CanonicalAad,
): Promise<string> {
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromHex(sealed.nonce),
        additionalData: aadBytes(aad),
      },
      await importKey(keyMaterial(keyring, aad.generation)),
      fromHex(sealed.ciphertext),
    );
    return new TextDecoder().decode(opened);
  } catch (error) {
    if (error instanceof SystemError) throw error;
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "A stored canonical credential could not be decrypted",
      error,
    );
  }
}
