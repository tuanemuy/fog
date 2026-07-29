// The floor belongs to the codec's construction boundary; restating it
// here would let the two drift, and a secret that satisfies this check
// but not the codec's would pass the brand and then fail at container
// construction — outside the error middleware.
import { MIN_SESSION_SECRET_LENGTH } from "@repo/core/adapters/webcrypto/hmacSessionCodec";

/**
 * Secrets a request container needs, held in their own nested object.
 *
 * The nesting is load-bearing. Every `createXxxRequestContainer` builds
 * `AppConfig` by rest-spreading its runtime config
 * (`const { db, relayTrigger, secrets, ...appConfig } = config`), and
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
 * The env schema keeps `SESSION_SECRET` optional on purpose: the same
 * `ServerEnv` shape is read by the relay / consumer / pruner / DLQ
 * Workers, which never touch a session, and a required key there would
 * stop those workers from booting. Requiring it in the request-config
 * reader instead means only the request path — the sole consumer —
 * demands the secret.
 *
 * Cloudflare has no boot phase in which `env` exists, so the request
 * config is necessarily per-request; the check still runs before the
 * isolate does any work, and the message names only the variable, never
 * a value.
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
