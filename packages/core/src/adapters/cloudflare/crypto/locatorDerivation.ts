import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { MappingKeyEntry } from "./keyring";

/** SHA-256 rendered as lowercase hex — the full length, never truncated. */
export const LOCATOR_HMAC_HEX_LENGTH = 64;

const MAPPING_PATTERN = /^g(\d+):b(\d+):([0-9a-f]{64})$/;

/**
 * Where one credential lives on the Identity Directory side, for one
 * generation of the mapping key.
 *
 * Deriving it needs the mapping key, which is distributed to the request
 * Worker and to nothing else — so this is computed before any Durable
 * Object is entered, and every entry that needs it receives it as
 * primitives.
 */
export type DerivedLocator = Readonly<{
  kind: CredentialKind;
  /** Lowercase hex, {@link LOCATOR_HMAC_HEX_LENGTH} characters. */
  hmac: string;
  generation: number;
  bucketIndex: number;
}>;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The canonical form of an SSO subject.
 *
 * `U+0000` separates the two parts because it occurs in neither, so no
 * pair of (provider, subject) can be spelled two ways or collide with
 * another pair — which a plain concatenation would allow.
 */
export function ssoCanonical(
  provider: string,
  providerSubject: string,
): string {
  return `${provider}\u0000${providerSubject}`;
}

/**
 * Picks the bucket from the derived value: the first four bytes read
 * big-endian, modulo the generation's bucket count.
 *
 * **Derived from the HMAC rather than hashed again** so the bucket is a
 * function of material the caller already holds, and **taken from the
 * front** so the rule is stated once and cannot drift between the writer
 * and the reader. Changing this function re-buckets every existing
 * credential, so it is a change of generation, not a change of code.
 *
 * **`bucketCount` has to be a power of two**: the modulo is taken over
 * `2^32`, which no other count divides evenly, so the leading buckets
 * would take a larger share than the rest.
 */
export function bucketIndexOf(hmac: string, bucketCount: number): number {
  return Number.parseInt(hmac.slice(0, 8), 16) % bucketCount;
}

/** `dir:g{generation}:b{index}` — the name the bucket's Durable Object is opened under. */
export function directoryBucketLocator(
  generation: number,
  bucketIndex: number,
): string {
  return `dir:g${generation}:b${bucketIndex}`;
}

/** The bucket that owns a derived locator. */
export function bucketLocatorOf(locator: DerivedLocator): string {
  return directoryBucketLocator(locator.generation, locator.bucketIndex);
}

/**
 * Derives where a canonical credential lives, under one generation of the
 * mapping key.
 *
 * The canonical value is the one the `Email` value object produced, or
 * {@link ssoCanonical} for an SSO subject — there is no second place a
 * canonical form is decided.
 *
 * Asynchronous, and therefore **never callable from inside
 * `transactionSync`**: `crypto.subtle` has no synchronous surface. The
 * transaction receives the result, not the computation.
 */
export async function deriveLocator(
  entry: MappingKeyEntry,
  kind: CredentialKind,
  canonical: string,
): Promise<DerivedLocator> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(entry.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonical),
  );
  const hmac = toHex(new Uint8Array(signature));
  return {
    kind,
    hmac,
    generation: entry.generation,
    bucketIndex: bucketIndexOf(hmac, entry.bucketCount),
  };
}

/**
 * Renders a derived locator as the opaque `mapping` string the domain
 * passes around (`CredentialLocator.mapping`,
 * `CredentialCoordinate.mapping`).
 *
 * **This module is the only thing that reads into that string.** The
 * `kind` is not part of it: it travels as its own field everywhere the
 * mapping does, and duplicating it would let the two disagree.
 */
export function encodeMapping(locator: DerivedLocator): string {
  return `g${locator.generation}:b${locator.bucketIndex}:${locator.hmac}`;
}

/**
 * Reads a `mapping` string back, or `null` if it is not one.
 *
 * Returns `null` rather than throwing because the callers that decode are
 * reading stored rows: a value that does not parse is a row that has
 * drifted from the schema, which the store translates into
 * `SystemError(DataIntegrityError)` with the context this function does
 * not have.
 */
export function decodeMapping(
  kind: CredentialKind,
  mapping: string,
): DerivedLocator | null {
  const match = MAPPING_PATTERN.exec(mapping);
  if (!match) return null;
  const [, generation, bucketIndex, hmac] = match;
  if (!generation || !bucketIndex || !hmac) return null;
  const parsedGeneration = Number.parseInt(generation, 10);
  const parsedBucketIndex = Number.parseInt(bucketIndex, 10);
  // The pattern already fixed each group to digits / 64 hex characters,
  // so numeric overflow is the only thing left to reject.
  if (
    !Number.isSafeInteger(parsedGeneration) ||
    !Number.isSafeInteger(parsedBucketIndex)
  ) {
    return null;
  }
  return {
    kind,
    hmac,
    generation: parsedGeneration,
    bucketIndex: parsedBucketIndex,
  };
}
