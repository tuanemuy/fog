import type {
  DirectoryRoutingKeyring,
  KeyringEntry,
} from "@repo/core/application/di/secrets";
import type { DirectoryLocator } from "@repo/core/lib/directoryLocator";

/**
 * canonical → Identity Directory bucket.
 *
 * **Runs in the request Worker and nowhere else.** `DIRECTORY_ROUTING_SECRET`
 * is not a state-Worker binding, so a bucket cannot derive its own name; that
 * asymmetry is what keeps a raw address from being reconstructable inside the
 * Directory, and it is why the DO-side repository is keyed on `(kind, hmac)`
 * rather than on an address (ADR-016).
 *
 * The output is a two-stage structure. The bucket index is the first two bytes
 * of the HMAC read big-endian, modulo that generation's bucket count —
 * collisions there are expected and harmless, because the bucket is only a
 * routing decision. **Identity is the full 256-bit HMAC**, which is what a
 * mapping row is keyed by, and a coincidental collision on 256 bits does not
 * happen in practice.
 */

export type { DirectoryLocator };

export interface DirectoryLocatorResolver {
  /**
   * Locators to try, active generation first, then the previous one if the
   * keyring still carries it. Reads *and* uniqueness registration consult every
   * generation, because during a rotation a credential legitimately has rows in
   * two buckets.
   *
   * **Non-empty**, and callers rely on it: `locators[0]` is the active
   * generation and every write goes there. The guarantee comes from `Keyring`,
   * whose only construction site rejects a keyring with no active generation.
   */
  forCanonical(
    canonical: string,
  ): Promise<readonly [DirectoryLocator, ...DirectoryLocator[]]>;
}

export function createDirectoryLocator(
  keyring: DirectoryRoutingKeyring,
): DirectoryLocatorResolver {
  const keys = new Map<number, Promise<CryptoKey>>();
  const encoder = new TextEncoder();

  function keyFor(generation: number, secret: string): Promise<CryptoKey> {
    let key = keys.get(generation);
    if (key === undefined) {
      key = crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      keys.set(generation, key);
    }
    return key;
  }

  async function locatorFor(
    entry: KeyringEntry,
    canonical: string,
  ): Promise<DirectoryLocator> {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await keyFor(entry.generation, entry.key),
        encoder.encode(canonical),
      ),
    );
    const hmac = [...signature]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const bucketIndex =
      (((signature[0] ?? 0) << 8) | (signature[1] ?? 0)) % entry.bucketCount;
    return {
      generation: entry.generation,
      bucketIndex,
      hmac,
      doName: `dir:g${entry.generation}:b${bucketIndex}`,
    };
  }

  return {
    async forCanonical(
      canonical: string,
    ): Promise<readonly [DirectoryLocator, ...DirectoryLocator[]]> {
      // Destructured rather than looped over from index 0, so the non-empty
      // tuple survives into the result without a cast.
      const [active, ...previous] = keyring.entries;
      const locators: [DirectoryLocator, ...DirectoryLocator[]] = [
        await locatorFor(active, canonical),
      ];
      for (const entry of previous) {
        locators.push(await locatorFor(entry, canonical));
      }
      return locators;
    },
  };
}
