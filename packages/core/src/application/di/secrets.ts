// The floor belongs to the codec's construction boundary; restating it
// here would let the two drift, and a secret that satisfies this check
// but not the codec's would pass the brand and then fail at container
// construction — outside the error middleware.
import {
  createMappingKeyring,
  INITIAL_DIRECTORY_BUCKET_COUNT,
  INITIAL_KEY_GENERATION,
  type MappingKeyring,
  MIN_KEYRING_SECRET_LENGTH,
} from "@repo/core/adapters/cloudflare/crypto/keyring";
import { MIN_SESSION_SECRET_LENGTH } from "@repo/core/adapters/webcrypto/hmacSessionCodec";

/**
 * Secrets a request container needs, held in their own nested object.
 *
 * The nesting is load-bearing. `createRequestContainer` builds
 * `AppConfig` by rest-spreading its runtime config
 * (`const { …, secrets, ...appConfig } = config`), and
 * `appConfig satisfies AppConfig` is a `satisfies` on a *variable*, which
 * does not run excess-property checking. A secret placed flat on
 * `RequestServerConfig` would therefore ride the spread into
 * `container.config` and out to the client through `loadAppContext` —
 * with no type error anywhere. Keeping secrets one level down means the
 * spread cannot reach them, and the same protection extends for free to
 * any secret added later.
 */
export type RequestSecrets = Readonly<{
  sessionSecret: SessionSecret;
  /**
   * The routing keyring, already built and validated. It is a keyring
   * rather than a secret string for the same reason `sessionSecret` is
   * branded: the only way to hold one is to have run the check.
   */
  directoryRoutingKeyring: MappingKeyring;
}>;

declare const sessionSecretBrand: unique symbol;

/**
 * A session secret that has passed {@link requireSessionSecret}.
 *
 * Branded so "the deployment set no `SESSION_SECRET`" cannot be smuggled
 * into a `RequestSecrets` as `""` or `undefined`: the only way to obtain
 * the type is to run the check, so every consumer downstream of the
 * request config holds a secret that was validated once, at the point the
 * config was built.
 */
export type SessionSecret = string & {
  readonly [sessionSecretBrand]: true;
};

/**
 * Asserts a usable `SESSION_SECRET` while the request config is built.
 *
 * `ServerEnv` keeps `SESSION_SECRET` optional, as it does every secret.
 * It is a hand-written type with no runtime validation, used only to
 * annotate the request Worker's `fetch` and `queue` parameters, so
 * marking it required would fail neither a boot nor `pnpm typecheck`; it
 * would only claim that `wrangler secret put` had already been run
 * against this Worker's config for this stage (`.dev.vars.example`
 * declares which Worker owns which secret). Optional keeps the type
 * honest, and this function puts the actual guarantee where the secret
 * is consumed: the request path, which cannot build its config without
 * one. The `queue()` handlers read the same shape and touch no session.
 *
 * Cloudflare hands `env` to a handler and never to module scope, so
 * there is no boot phase that could validate it and the request config
 * is necessarily per-request. The check still runs before the container
 * is built, and the message names only the variable, never a value.
 */
export function requireSessionSecret(
  secret: string | undefined,
): SessionSecret {
  if (secret === undefined || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET is required on the request path and must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }
  return secret as SessionSecret;
}

/**
 * Builds the mapping keyring the request Worker routes credentials with.
 *
 * **Ownership is the reason this lives on the request side.** The mapping
 * key is what turns a canonical credential into the full-length value the
 * Identity Directory bucket is chosen from, and bucket selection happens
 * in the stub-selection adapter — before any Durable Object exists. It is
 * deliberately not one of the three keys that stay inside a DO.
 *
 * **This is the minimal form: one active generation, no previous.** The
 * shape is already the collection a rotation needs (see
 * {@link createMappingKeyring}), but the machinery around it — the key
 * commitment, the generation guard on reservations, the second probe —
 * is not here, so the deployment cannot actually rotate this key yet.
 *
 * Like {@link requireSessionSecret}, the check runs while the request
 * config is built and the message names only the variable.
 */
export function requireDirectoryRoutingKeyring(
  secret: string | undefined,
): MappingKeyring {
  if (secret === undefined || secret.length < MIN_KEYRING_SECRET_LENGTH) {
    throw new Error(
      `DIRECTORY_ROUTING_SECRET is required on the request path and must be at least ${MIN_KEYRING_SECRET_LENGTH} characters`,
    );
  }
  return createMappingKeyring([
    {
      role: "active",
      generation: INITIAL_KEY_GENERATION,
      key: secret,
      bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT,
    },
  ]);
}
