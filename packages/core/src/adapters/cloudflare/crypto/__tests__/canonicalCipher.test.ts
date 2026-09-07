import { fromBase64, toBase64 } from "@repo/core/adapters/webcrypto/encoding";
import type { SealedCanonical } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { describe, expect, it } from "vitest";
import {
  type CanonicalAad,
  openCanonical,
  sealCanonical,
} from "../canonicalCipher";
import {
  createEncryptionKeyring,
  type EncryptionKeyring,
  INITIAL_KEY_GENERATION,
} from "../keyring";

const SECRET = "test-identity-mail-encryption-key-0123456789";
const CANONICAL = "user@example.com";
const AAD: CanonicalAad = { kind: "email", credentialId: "cred-1" };

function keyring(generation = INITIAL_KEY_GENERATION): EncryptionKeyring {
  return createEncryptionKeyring([{ role: "active", generation, key: SECRET }]);
}

describe("sealCanonical / openCanonical", () => {
  it("returns the original value through a round trip", async () => {
    const sealed = await sealCanonical(keyring(), AAD, CANONICAL);

    expect(sealed.ciphertext).not.toContain(CANONICAL);
    expect(sealed.encryptionGeneration).toBe(INITIAL_KEY_GENERATION);
    await expect(openCanonical(keyring(), AAD, sealed)).resolves.toBe(
      CANONICAL,
    );
  });

  // Reusing a nonce under one key is what makes AES-GCM leak the
  // plaintexts, and the write path re-seals on every convergence — so
  // "fresh per call" is the property, not "fresh per row".
  it("draws a new nonce and produces new ciphertext on every write", async () => {
    const first = await sealCanonical(keyring(), AAD, CANONICAL);
    const second = await sealCanonical(keyring(), AAD, CANONICAL);

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    // Its own field, never concatenated onto the ciphertext: the column is
    // separate and the schema's NOT NULL is on that column.
    expect(first.ciphertext).not.toContain(first.nonce);
    await expect(openCanonical(keyring(), AAD, second)).resolves.toBe(
      CANONICAL,
    );
  });

  // The binding is what stops a ciphertext being moved onto another row
  // and read back there.
  it.each([
    ["another credential", { kind: "email", credentialId: "cred-2" }],
    ["another kind", { kind: "sso", credentialId: "cred-1" }],
  ] as const)("refuses a value read back under %s", async (_label, aad) => {
    const sealed = await sealCanonical(keyring(), AAD, CANONICAL);

    await expect(openCanonical(keyring(), aad, sealed)).resolves.toBeNull();
  });

  // A retired generation is a decidable failure rather than garbage: the
  // keyring no longer holds the entry, so there is nothing to try.
  it("refuses a value sealed under a generation the keyring no longer holds", async () => {
    const sealed = await sealCanonical(keyring(2), AAD, CANONICAL);

    await expect(openCanonical(keyring(1), AAD, sealed)).resolves.toBeNull();
  });

  // Flipped at the byte level rather than in the base64 text: the last
  // encoded character carries bits the decoder discards, so editing it can
  // leave the bytes — and therefore the answer — unchanged.
  it("refuses a tampered ciphertext instead of raising", async () => {
    const sealed = await sealCanonical(keyring(), AAD, CANONICAL);
    const bytes = fromBase64(sealed.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered: SealedCanonical = {
      ...sealed,
      ciphertext: toBase64(bytes),
    };

    await expect(openCanonical(keyring(), AAD, tampered)).resolves.toBeNull();
  });
});
