import { MIN_SESSION_SECRET_LENGTH } from "@repo/core/lib/secretLengths";

/**
 * The secrets each composition root needs, held in their own nested objects.
 *
 * **The nesting is load-bearing.** `createRequestContainer` builds `AppConfig`
 * by rest-spreading its runtime config, and `satisfies AppConfig` on a
 * *variable* does not run excess-property checking — so a secret placed flat on
 * `RequestServerConfig` would ride that spread into `container.config` and out
 * to the browser through `loadAppContext`, with no type error anywhere. One
 * level down, the spread cannot reach it, and the protection extends for free
 * to every secret added later.
 *
 * The split between the two shapes is the distribution boundary itself.
 * `DIRECTORY_ROUTING_SECRET` is on the request side **only**: handing it to the
 * state Worker would let a bucket derive its own name from a raw address, which
 * is exactly what the design spends the HMAC to prevent. Symmetrically the
 * mail-encryption and reset-token keyrings are state-side only.
 */
export type RequestSecrets = Readonly<{
  sessionSecret: SessionSecret;
  aiClientTokenSecret: AiClientTokenSecret;
  directoryRoutingKeyring: DirectoryRoutingKeyring;
}>;

export type StateSecrets = Readonly<{
  mailEncryptionKeyring: Keyring;
  resetTokenKeyring: Keyring;
}>;

declare const sessionSecretBrand: unique symbol;
declare const aiClientTokenSecretBrand: unique symbol;
declare const keyringBrand: unique symbol;
declare const directoryRoutingKeyringBrand: unique symbol;

/**
 * A secret that has passed its check.
 *
 * Branded so "the deployment set nothing" cannot be smuggled in as `""` or
 * `undefined`: the only way to obtain the type is to run the check, so every
 * consumer downstream holds a value that was validated once, where the config
 * was built.
 */
export type SessionSecret = string & { readonly [sessionSecretBrand]: true };

/**
 * Signing key for AI client tokens. **A separate key from the session secret**,
 * because the two token kinds differ in TTL, in how they are revoked and in
 * when they are issued — sharing a key would make either rotation drag the
 * other down with it.
 */
export type AiClientTokenSecret = string & {
  readonly [aiClientTokenSecretBrand]: true;
};

export type KeyringEntry = Readonly<{
  generation: number;
  key: string;
  /** Directory routing only: how many buckets that generation was split into. */
  bucketCount: number;
}>;

/**
 * Active generation first, then the previous one if there is one.
 *
 * A **non-empty** tuple, because `requireKeyring` — the single construction
 * site — rejects anything that does not declare exactly one active generation.
 * Saying so in the type is what lets `forCanonical` promise at least one
 * locator, so the signup saga needs no "the keyring produced no active
 * locator" branch.
 */
export type Keyring = Readonly<{
  entries: readonly [KeyringEntry, ...KeyringEntry[]];
}> & { readonly [keyringBrand]: true };

export type DirectoryRoutingKeyring = Keyring & {
  readonly [directoryRoutingKeyringBrand]: true;
};

/** The JSON shape a keyring env var carries. */
type RawKeyringEntry = {
  generation?: unknown;
  key?: unknown;
  bucketCount?: unknown;
  role?: unknown;
};

export function requireSessionSecret(
  secret: string | undefined,
): SessionSecret {
  return requireSecret(secret, "SESSION_SECRET") as SessionSecret;
}

export function requireAiClientTokenSecret(
  secret: string | undefined,
): AiClientTokenSecret {
  return requireSecret(secret, "AI_CLIENT_TOKEN_SECRET") as AiClientTokenSecret;
}

/**
 * Asserts a usable single-key secret while a container's config is built.
 *
 * `ServerEnv` keeps these optional on purpose: it is a hand-written type with
 * no runtime validation, so marking a field required would enforce nothing —
 * it would neither fail a boot nor fail `pnpm typecheck`. Optional keeps the
 * type honest and this function puts the actual guarantee at the point of
 * consumption.
 *
 * The floor comes from `lib/secretLengths.ts` rather than being restated here,
 * so raising it cannot split this check from the codec's.
 *
 * The message names the variable and never the value it was handed.
 */
function requireSecret(secret: string | undefined, name: string): string {
  if (secret === undefined || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `${name} is required and must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

/**
 * Parses and validates a keyring, which is a JSON array of
 * `{ generation, key, bucketCount?, role? }`.
 *
 * Four invariants, checked here so that **only a checked value can obtain the
 * type**: generations are unique, exactly one entry is `active`, at most one is
 * `previous`, and — for directory routing — every entry declares a
 * `bucketCount` of at least 1. That last one cannot be defaulted: the DO name
 * carries the bucket *index*, not the count, so a previous generation's modulus
 * is unrecoverable if it was not written down.
 *
 * Order is normalised to active-then-previous, which is the order lookups walk.
 */
export function requireKeyring(
  raw: string | undefined,
  name: string,
  options: { requireBucketCount: boolean },
): Keyring {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${name} is required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never echo the value: it is the secret.
    throw new Error(`${name} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${name} must be a non-empty JSON array`);
  }

  const active: KeyringEntry[] = [];
  const previous: KeyringEntry[] = [];
  const generations = new Set<number>();

  for (const item of parsed as RawKeyringEntry[]) {
    if (typeof item !== "object" || item === null) {
      throw new Error(`${name} entries must be objects`);
    }
    const { generation, key, bucketCount, role } = item;
    if (typeof generation !== "number" || !Number.isInteger(generation)) {
      throw new Error(`${name} entries must carry an integer generation`);
    }
    if (generations.has(generation)) {
      throw new Error(`${name} repeats generation ${generation}`);
    }
    generations.add(generation);
    if (typeof key !== "string" || key.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `${name} entries must carry a key of at least ${MIN_SESSION_SECRET_LENGTH} characters`,
      );
    }
    if (options.requireBucketCount) {
      if (
        typeof bucketCount !== "number" ||
        !Number.isInteger(bucketCount) ||
        bucketCount < 1
      ) {
        throw new Error(
          `${name} entries must carry a bucketCount of 1 or more`,
        );
      }
    }
    const entry: KeyringEntry = {
      generation,
      key,
      bucketCount: typeof bucketCount === "number" ? bucketCount : 1,
    };
    if (role === "previous") previous.push(entry);
    else if (role === undefined || role === "active") active.push(entry);
    else throw new Error(`${name} entries must be "active" or "previous"`);
  }

  if (active.length !== 1) {
    throw new Error(`${name} must declare exactly one active generation`);
  }
  if (previous.length > 1) {
    throw new Error(`${name} must declare at most one previous generation`);
  }
  // The brand exists only so that a keyring cannot be built without passing the
  // four checks above; this is its single construction site.
  return { entries: [...active, ...previous] } as unknown as Keyring;
}

export function requireDirectoryRoutingKeyring(
  raw: string | undefined,
): DirectoryRoutingKeyring {
  return requireKeyring(raw, "DIRECTORY_ROUTING_SECRET", {
    requireBucketCount: true,
  }) as DirectoryRoutingKeyring;
}
