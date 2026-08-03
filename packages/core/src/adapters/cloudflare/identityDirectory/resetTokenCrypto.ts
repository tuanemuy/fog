import type { Keyring } from "@repo/core/application/di/secrets";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";

/**
 * The three values a password-reset link is made of, and the one derivation
 * chain that connects them.
 *
 * ```
 * tokenId  --HMAC(IDENTITY_RESET_TOKEN_KEY[gen])-->  secret
 * secret   --SHA-256-------------------------------> tokenHash   (the stored row)
 * secret   --prefixed with routing coordinates-----> the mailed link
 * ```
 *
 * **Issuing, delivering and verifying all read this module**, which is the
 * point: three independent derivations cannot be relied on to agree, and their
 * disagreement is silent — a mailed link that finds no row, or a value that
 * finds one (`token_id`, sitting in the clear in the primary key) but was never
 * mailed.
 *
 * ## What a database dump does not yield
 *
 * The row holds `token_id` and `SHA-256(secret)`. Producing `secret` from
 * `token_id` needs the reset-token keyring, which is a state-Worker secret and
 * is not in the database; producing it from the hash needs a SHA-256 pre-image.
 * Submitting `token_id` itself matches nothing, because the row is keyed by the
 * hash of the *derived* secret and not by a hash of `token_id`.
 *
 * ## Why this is asynchronous while the port is not
 *
 * WebCrypto is asynchronous and a `run()` callback is type-rejected from being
 * asynchronous, so every function here runs in the Durable Object's **RPC entry
 * point**, before the transaction opens, and hands plain strings to the
 * synchronous port. That is the same shape `sealCanonical` uses for the
 * encrypted canonical.
 */

const TOKEN_ID_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The material a token row is written from. All primitives; no secret on it. */
export type ResetTokenMaterial = Readonly<{
  /** Row identity. Never accepted as proof of anything on its own. */
  tokenId: string;
  /** `SHA-256(secret)` — what `verifyAndConsume` matches against. */
  tokenHash: string;
  /** The keyring generation that signed it, recorded so a rotation can tell. */
  tokenKeyGeneration: number;
}>;

/**
 * 128 bits of randomness, minted inside a handler.
 *
 * Never at module scope: workerd refuses to produce randomness in the global
 * scope, and a Durable Object class body is global scope.
 */
export function mintResetTokenId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(TOKEN_ID_BYTES)));
}

function entryFor(keyring: Keyring, generation: number): string {
  const entry = keyring.entries.find(
    (candidate) => candidate.generation === generation,
  );
  if (entry === undefined) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      `No reset token key for generation ${generation}`,
    );
  }
  return entry.key;
}

/** The keyring's active generation — the one a new token is signed under. */
export function activeResetTokenGeneration(keyring: Keyring): number {
  const generation = keyring.entries[0]?.generation;
  if (generation === undefined) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      "IDENTITY_RESET_TOKEN_KEY declares no active generation",
    );
  }
  return generation;
}

/**
 * The bearer half of the link. Deterministic in `(key, tokenId)`, so the send
 * job can rebuild it from the row long after the request that issued it, and a
 * redelivery of that job rebuilds the same one.
 */
export async function deriveResetSecret(
  keyring: Keyring,
  generation: number,
  tokenId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(entryFor(keyring, generation)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(tokenId),
  );
  return toHex(new Uint8Array(signature));
}

/** The stored lookup key. Cryptographic, so the row is not a step to the link. */
export async function resetTokenDigest(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Mints a whole token, unconditionally.
 *
 * The caller runs this **before** deciding whether the request is eligible and
 * throws the result away when it is not: the four reset cases (registered,
 * unregistered, SSO-only, throttled) have to cost the same, and two WebCrypto
 * operations are a measurable amount of work.
 */
export async function mintResetTokenMaterial(
  keyring: Keyring,
): Promise<ResetTokenMaterial> {
  const tokenId = mintResetTokenId();
  const tokenKeyGeneration = activeResetTokenGeneration(keyring);
  const secret = await deriveResetSecret(keyring, tokenKeyGeneration, tokenId);
  return {
    tokenId,
    tokenHash: await resetTokenDigest(secret),
    tokenKeyGeneration,
  };
}

/**
 * `{routingGeneration}.{bucketIndex}.{secret}`.
 *
 * The two numbers are the issuing bucket's own routing coordinates, so the
 * consumption endpoint can address the bucket back **without** the routing
 * secret — which lives on the request Worker and is deliberately not
 * distributed to the state Worker. They are the *routing* generation;
 * the reset-token key generation is a separate number system and stays on the
 * row.
 *
 * They travel in a URL and come back as unauthenticated input, so the reverse
 * direction is not symmetric: {@link parseResetToken} takes the keyring and
 * refuses coordinates it does not declare.
 */
export function formatResetToken(
  routing: Readonly<{ generation: number; bucket: number }>,
  secret: string,
): string {
  return `${routing.generation}.${routing.bucket}.${secret}`;
}

export type ParsedResetToken = Readonly<{
  generation: number;
  bucket: number;
  secret: string;
}>;

/**
 * The routing shape a generation was deployed with. Structurally satisfied by
 * `DirectoryRoutingKeyring["entries"]`, so the caller passes the keyring it
 * already holds rather than assembling a second table that could drift.
 */
export type RoutingBounds = readonly Readonly<{
  generation: number;
  bucketCount: number;
}>[];

/**
 * The inverse of {@link formatResetToken}. `null` for anything malformed — an
 * unparseable token is exactly as invalid as an unknown one, and the caller
 * must not be able to tell the two apart.
 *
 * ## The two numbers are checked against the keyring, not merely parsed
 *
 * They come from an unauthenticated URL and they are Durable Object addressing
 * coordinates: a caller who could put arbitrary values through them would mint
 * arbitrary new buckets, each running its migration gate and writing `_meta`.
 * AC-4's guarantee is that no external input reaches `idFromName`, and reset
 * consumption is the one flow that must route by a token rather than by a
 * verified session — so the bound has to be enforced *here*, before a name is
 * built. `bucketCount` is per generation, and only the keyring knows it: the
 * name carries the bucket index, never the modulus.
 *
 * An out-of-range coordinate answers `null`, the same answer an unknown token
 * gets, so the check adds no observable.
 */
export function parseResetToken(
  token: string,
  routing: RoutingBounds,
): ParsedResetToken | null {
  const match = /^(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(token);
  if (match === null) return null;
  const generation = Number(match[1]);
  const bucket = Number(match[2]);
  const entry = routing.find(
    (candidate) => candidate.generation === generation,
  );
  if (entry === undefined) return null;
  if (bucket >= entry.bucketCount) return null;
  return { generation, bucket, secret: match[3] as string };
}

/** Loud rather than silent: an unconfigured keyring must not mint a dead link. */
export function requireResetTokenKeyring(keyring: Keyring | null): Keyring {
  if (keyring === null) {
    throw new SystemError(
      SystemErrorCode.CryptoError,
      "IDENTITY_RESET_TOKEN_KEY is not configured on the state Worker",
    );
  }
  return keyring;
}
