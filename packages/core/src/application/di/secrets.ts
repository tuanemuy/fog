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
 * any secret added later (ADR-002).
 */
export type RequestSecrets = Readonly<{
  sessionSecret: string;
}>;

const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Asserts a usable `SESSION_SECRET` at the one place that consumes it.
 *
 * The env schemas keep `SESSION_SECRET` optional on purpose: the AWS and
 * GCP env readers are shared with the relay / consumer / pruner / DLQ
 * entry points, which never touch a session, and a required key there
 * would stop those workers from booting. Requiring it here instead means
 * only the request path — the sole consumer — demands the secret
 * (ADR-004).
 */
export function requireSessionSecret(secret: string | undefined): string {
  if (secret === undefined || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET is required on the request path and must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}
