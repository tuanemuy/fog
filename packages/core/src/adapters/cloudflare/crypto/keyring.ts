import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { z } from "zod";

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

const roleSchema = z.enum(["active", "previous"]);
const generationSchema = z.number().int().min(1);

/** `DIRECTORY_ROUTING_KEYRING`: `[{ role, generation, key, bucketCount }]`. */
const mappingKeyringJsonSchema = z.array(
  z.object({
    role: roleSchema,
    generation: generationSchema,
    key: z.string(),
    bucketCount: z.number().int().min(1),
  }),
);

/** `IDENTITY_MAIL_ENCRYPTION_KEYRING`: `[{ role, generation, key }]`. */
const encryptionKeyringJsonSchema = z.array(
  z.object({ role: roleSchema, generation: generationSchema, key: z.string() }),
);

/** `DIRECTORY_KEY_COMMITMENT`: `[{ role, generation, keyDigest, bucketCount }]`. */
const keyCommitmentJsonSchema = z.array(
  z.object({
    role: roleSchema,
    generation: generationSchema,
    keyDigest: z.string().regex(/^[0-9a-f]{64}$/),
    bucketCount: z.number().int().min(1),
  }),
);

// The JSON variables are parsed with the value kept out of the message:
// a keyring variable holds key material, and the failure reaches a log.
function parseJsonVariable<T>(
  name: string,
  raw: string,
  schema: z.ZodType<T>,
  fail: (message: string) => never,
): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(`${name} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return fail(`${name} does not have the declared shape`);
  return parsed.data;
}

function configurationError(message: string): never {
  throw new SystemError(SystemErrorCode.ConfigurationError, message);
}

/**
 * Builds the mapping keyring the request Worker routes with, from the two
 * variables `spec/rotation/index.md` (鍵材料の配布形) declares: the JSON
 * array `DIRECTORY_ROUTING_KEYRING` when it is set, otherwise a single
 * `active` generation 1 from `DIRECTORY_ROUTING_SECRET`. When the array is
 * set the single variable is not read at all.
 *
 * Throws a bare `Error` like the other request-side secret checks in
 * `secrets.ts`: the request config is built before any error boundary,
 * and the message names only the variable.
 */
export function mappingKeyringFromEnv(
  keyringJson: string | undefined,
  singleSecret: string | undefined,
): MappingKeyring {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  if (keyringJson !== undefined && keyringJson.length > 0) {
    const entries = parseJsonVariable(
      "DIRECTORY_ROUTING_KEYRING",
      keyringJson,
      mappingKeyringJsonSchema,
      fail,
    );
    try {
      return createMappingKeyring(entries);
    } catch (error) {
      return fail(
        `DIRECTORY_ROUTING_KEYRING is not a valid keyring: ${error instanceof Error ? error.message : "invalid"}`,
      );
    }
  }
  if (
    singleSecret === undefined ||
    singleSecret.length < MIN_KEYRING_SECRET_LENGTH
  ) {
    return fail(
      `DIRECTORY_ROUTING_SECRET is required on the request path (or DIRECTORY_ROUTING_KEYRING) and must be at least ${MIN_KEYRING_SECRET_LENGTH} characters`,
    );
  }
  return createMappingKeyring([
    {
      role: "active",
      generation: INITIAL_KEY_GENERATION,
      key: singleSecret,
      bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
    },
  ]);
}

/**
 * Builds the email encryption keyring from the state Worker's variables:
 * the JSON array `IDENTITY_MAIL_ENCRYPTION_KEYRING` when set, otherwise a
 * single `active` generation 1 from `IDENTITY_MAIL_ENCRYPTION_KEY`.
 *
 * Read inside the Durable Object rather than in a DI module: this key is
 * one of the three that never leave the state Worker, and there is no
 * request-side container that could hold it.
 *
 * The message names the variable and never a value.
 *
 * A `SystemError` rather than the bare `Error` the request-side factory
 * throws: this one runs inside the Durable Object, so the failure leaves
 * through the RPC value envelope, which files anything that is not a
 * `CodedError` under `UNCLASSIFIED_ERROR` with the constructor name for a
 * message — and the variable that is missing would not survive the trip.
 */
export function encryptionKeyringFromEnv(
  keyringJson: string | undefined,
  singleSecret: string | undefined,
): EncryptionKeyring {
  if (keyringJson !== undefined && keyringJson.length > 0) {
    const entries = parseJsonVariable(
      "IDENTITY_MAIL_ENCRYPTION_KEYRING",
      keyringJson,
      encryptionKeyringJsonSchema,
      configurationError,
    );
    try {
      return createEncryptionKeyring(entries);
    } catch (error) {
      return configurationError(
        `IDENTITY_MAIL_ENCRYPTION_KEYRING is not a valid keyring: ${error instanceof Error ? error.message : "invalid"}`,
      );
    }
  }
  if (
    singleSecret === undefined ||
    singleSecret.length < MIN_KEYRING_SECRET_LENGTH
  ) {
    return configurationError(
      `IDENTITY_MAIL_ENCRYPTION_KEY is required on the Identity Directory (or IDENTITY_MAIL_ENCRYPTION_KEYRING) and must be at least ${MIN_KEYRING_SECRET_LENGTH} characters`,
    );
  }
  return createEncryptionKeyring([
    { role: "active", generation: INITIAL_KEY_GENERATION, key: singleSecret },
  ]);
}

/** The single-variable form, kept for the callers that predate the keyring variable. */
export function requireEmailEncryptionKeyring(
  secret: string | undefined,
): EncryptionKeyring {
  return encryptionKeyringFromEnv(undefined, secret);
}

/**
 * One entry of the **key commitment** — what the state Worker holds about
 * a mapping-key generation without holding the key: its role, its number,
 * `SHA-256(key)` and its bucket count (`spec/rotation/index.md`, 鍵の配布と
 * コミットメント).
 */
export type KeyCommitmentEntry = Readonly<{
  role: KeyRole;
  generation: number;
  /** Lowercase hex SHA-256 of the key material. */
  keyDigest: string;
  bucketCount: number;
}>;

declare const keyCommitmentBrand: unique symbol;

/**
 * The state Worker's commitment to the mapping keyring: the same
 * role-tagged generation set, digests in place of keys. Branded like the
 * keyrings, so holding one means the role invariants were checked.
 */
export type KeyCommitment = Readonly<{
  entries: readonly KeyCommitmentEntry[];
}> & { readonly [keyCommitmentBrand]: true };

export function createKeyCommitment(
  entries: readonly KeyCommitmentEntry[],
): KeyCommitment {
  assertRoles(entries);
  for (const entry of entries) {
    assertGeneration(entry.generation);
    if (!Number.isInteger(entry.bucketCount) || entry.bucketCount < 1) {
      throw new Error("Bucket count must be an integer >= 1");
    }
  }
  return { entries: inProbeOrder(entries) } as KeyCommitment;
}

/**
 * Reads `DIRECTORY_KEY_COMMITMENT`, or `null` when it is not set.
 *
 * `null` is the single-generation state: the generation guard has no
 * `active` to compare against and degrades to the identity, and the
 * transfer entries — which take an injected key and must verify it
 * against something — refuse with `SystemError(ConfigurationError)`.
 * A previous generation is never deployed without a commitment
 * (`spec/rotation/index.md`), so the guard cannot be circumvented by
 * leaving the variable out.
 */
export function keyCommitmentFromEnv(
  json: string | undefined,
): KeyCommitment | null {
  if (json === undefined || json.length === 0) return null;
  const entries = parseJsonVariable(
    "DIRECTORY_KEY_COMMITMENT",
    json,
    keyCommitmentJsonSchema,
    configurationError,
  );
  try {
    return createKeyCommitment(entries);
  } catch (error) {
    return configurationError(
      `DIRECTORY_KEY_COMMITMENT is not a valid commitment: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
}

/** The committed `previous` generation, or `null` while no rotation is open. */
export function previousKey<T extends { role: KeyRole }>(keyring: {
  entries: readonly T[];
}): T | null {
  return (
    keyring.entries.find((candidate) => candidate.role === "previous") ?? null
  );
}

const encoder = new TextEncoder();

/** `SHA-256(key)` as lowercase hex — the commitment's `keyDigest`. */
export async function keyDigestOf(key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(key)),
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The four-point check a bucket runs on an injected keyring entry before
 * using it: `role`, `generation` present under that role, `keyDigest`
 * (constant time), `bucketCount`. One missing point and the entry is not
 * used — the failure is one `SystemError(ConfigurationError)` whose
 * message names none of the four, since the operator surface would carry
 * it out.
 *
 * Checking the role is what stops the two correct keys with their labels
 * swapped from driving a transfer backwards; there is no branch anywhere
 * that takes possession of the `previous` key as authorisation.
 */
export async function verifyKeyEntryAgainstCommitment(
  entry: MappingKeyEntry,
  commitment: KeyCommitment,
  expectedRole: KeyRole,
): Promise<void> {
  const committed = commitment.entries.find(
    (candidate) => candidate.role === expectedRole,
  );
  const digest = await keyDigestOf(entry.key);
  const matches =
    committed !== undefined &&
    entry.role === expectedRole &&
    committed.generation === entry.generation &&
    committed.bucketCount === entry.bucketCount &&
    constantTimeEqual(digest, committed.keyDigest);
  if (!matches) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "The injected keyring entry is not one this Identity Directory committed to",
    );
  }
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
