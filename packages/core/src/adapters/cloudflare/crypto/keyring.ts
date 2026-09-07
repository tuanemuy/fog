import { SystemError, SystemErrorCode } from "@repo/core/application/errors";

/**
 * Which end of a rotation an entry sits on.
 *
 * The label is carried rather than derived from the generation number: a
 * rotation that is rolled back has an `active` generation *below* its
 * `previous`, so `max(generation)` picks the wrong one.
 */
export type KeyRole = "active" | "previous";

/**
 * Floor for a keyring secret. The same reasoning as the session secret's:
 * forging an HMAC costs the key's entropy, so a key shorter than the
 * hash's output buys nothing.
 */
export const MIN_KEYRING_SECRET_LENGTH = 32;

/**
 * One generation of the **mapping key** — the key a canonical credential
 * is HMAC'd with to reach its Identity Directory bucket.
 *
 * `bucketCount` belongs to the generation and not to the deployment:
 * changing how many buckets there are *is* a new generation, so two
 * entries may legitimately disagree about it.
 */
export type MappingKeyEntry = Readonly<{
  role: KeyRole;
  generation: number;
  key: string;
  bucketCount: number;
}>;

/** One generation of the **email encryption key**. */
export type EncryptionKeyEntry = Readonly<{
  role: KeyRole;
  generation: number;
  key: string;
}>;

declare const mappingKeyringBrand: unique symbol;
declare const encryptionKeyringBrand: unique symbol;

/**
 * The mapping keyring, **ordered for probing**: the active entry first,
 * then any previous one.
 *
 * Branded so the only way to hold one is to have run
 * {@link createMappingKeyring}, which is where the invariants below are
 * checked.
 */
export type MappingKeyring = Readonly<{
  entries: readonly MappingKeyEntry[];
}> & { readonly [mappingKeyringBrand]: true };

export type EncryptionKeyring = Readonly<{
  entries: readonly EncryptionKeyEntry[];
}> & { readonly [encryptionKeyringBrand]: true };

function assertGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("Key generation must be an integer >= 1");
  }
}

function assertSecret(key: string): void {
  if (key.length < MIN_KEYRING_SECRET_LENGTH) {
    throw new Error(
      `Keyring secret must be at least ${MIN_KEYRING_SECRET_LENGTH} characters`,
    );
  }
}

// Shared by both keyrings: exactly one `active`, at most one `previous`,
// and no generation twice. The message never names a key or a digest of
// one — only the shape that was wrong.
function assertRoles(
  entries: readonly { role: KeyRole; generation: number }[],
) {
  if (entries.length === 0) {
    throw new Error("A keyring needs at least the active entry");
  }
  const active = entries.filter((entry) => entry.role === "active");
  if (active.length !== 1) {
    throw new Error("A keyring must hold exactly one active entry");
  }
  if (entries.length - active.length > 1) {
    throw new Error("A keyring holds at most one previous entry");
  }
  const generations = new Set(entries.map((entry) => entry.generation));
  if (generations.size !== entries.length) {
    throw new Error("A keyring must not hold one generation twice");
  }
}

// Probe order is the array order, so it is fixed once here rather than at
// each call site: a caller that iterates the entries is probing
// active-first by construction.
function inProbeOrder<T extends { role: KeyRole }>(
  entries: readonly T[],
): readonly T[] {
  return [...entries].sort((a, b) =>
    a.role === b.role ? 0 : a.role === "active" ? -1 : 1,
  );
}

/**
 * Builds the mapping keyring the request Worker routes with.
 *
 * **Today it is handed a single active entry**, and the two-generation
 * machinery a real rotation needs (the key commitment, the generation
 * guard on reservations, the re-probe of `active` after both misses, the
 * transfer RPCs) is not here. What *is* here is the shape: a collection,
 * ordered for probing, whose entries each carry their own generation —
 * so adding `previous` later changes neither this type nor any signature
 * derived from it.
 */
export function createMappingKeyring(
  entries: readonly MappingKeyEntry[],
): MappingKeyring {
  assertRoles(entries);
  for (const entry of entries) {
    assertGeneration(entry.generation);
    assertSecret(entry.key);
    if (!Number.isInteger(entry.bucketCount) || entry.bucketCount < 1) {
      throw new Error("Bucket count must be an integer >= 1");
    }
    // `bucketIndexOf` takes the modulo over `2^32`, which no count other
    // than a power of two divides evenly — and the placement is an
    // attribute of the generation, so a biased count cannot be corrected
    // afterwards.
    if ((entry.bucketCount & (entry.bucketCount - 1)) !== 0) {
      throw new Error("Bucket count must be a power of two");
    }
  }
  return { entries: inProbeOrder(entries) } as MappingKeyring;
}

/** Builds the email encryption keyring the state Worker decrypts with. */
export function createEncryptionKeyring(
  entries: readonly EncryptionKeyEntry[],
): EncryptionKeyring {
  assertRoles(entries);
  for (const entry of entries) {
    assertGeneration(entry.generation);
    assertSecret(entry.key);
  }
  return { entries: inProbeOrder(entries) } as EncryptionKeyring;
}

/**
 * The generation both keyrings start at. Deployment has not happened, so
 * every stored row carries it.
 */
export const INITIAL_KEY_GENERATION = 1;

/**
 * How many Identity Directory buckets generation 1 has.
 *
 * A constant rather than a deployment variable **because the count is
 * part of the generation, not of the environment**: every stored `hmac`
 * was bucketed with this number, so raising it re-buckets every existing
 * credential. Changing it is opening a new generation and transferring —
 * never an edit to this line.
 */
export const INITIAL_DIRECTORY_BUCKET_COUNT = 16;

/**
 * Builds the email encryption keyring from the state Worker's secret.
 *
 * Read inside the Durable Object rather than in a DI module: this key is
 * one of the three that never leave the state Worker, and there is no
 * request-side container that could hold it.
 *
 * The message names the variable and never a value.
 *
 * A `SystemError` rather than the bare `Error` the other keyring factories
 * throw: this one runs inside the Durable Object, so the failure leaves
 * through the RPC value envelope, which files anything that is not a
 * `CodedError` under `UNCLASSIFIED_ERROR` with the constructor name for a
 * message — and the variable that is missing would not survive the trip.
 */
export function requireEmailEncryptionKeyring(
  secret: string | undefined,
): EncryptionKeyring {
  if (secret === undefined || secret.length < MIN_KEYRING_SECRET_LENGTH) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      `IDENTITY_MAIL_ENCRYPTION_KEY is required on the Identity Directory and must be at least ${MIN_KEYRING_SECRET_LENGTH} characters`,
    );
  }
  return createEncryptionKeyring([
    { role: "active", generation: INITIAL_KEY_GENERATION, key: secret },
  ]);
}

/**
 * The entry new material is written under. Both keyrings are validated to
 * hold exactly one, so this cannot miss.
 */
export function activeKey<T extends { role: KeyRole }>(keyring: {
  entries: readonly T[];
}): T {
  const entry = keyring.entries.find(
    (candidate) => candidate.role === "active",
  );
  // Unreachable through the factories; kept so a future entry point that
  // builds a keyring some other way fails here instead of silently
  // writing under `previous`.
  if (!entry) throw new Error("Keyring holds no active entry");
  return entry;
}

/**
 * The entry a stored row was written under, or `null` if that generation
 * has already been retired — which is what makes reading a row from a
 * retired key a decidable failure rather than garbage.
 */
export function keyForGeneration<T extends { generation: number }>(
  keyring: { entries: readonly T[] },
  generation: number,
): T | null {
  return (
    keyring.entries.find((entry) => entry.generation === generation) ?? null
  );
}
