/**
 * Bindings the state Worker hands to the Durable Object classes.
 *
 * Deliberately narrow. In particular `DIRECTORY_ROUTING_SECRET_*` is **not**
 * here: canonical → HMAC → locator derivation belongs to the request Worker,
 * and handing the routing secret to the state Worker would break the
 * non-duplicated-distribution rule (ADR-016).
 *
 * Replaced by the real definition in
 * `packages/core/src/application/di/stateCloudflare.ts` in step 17.
 */
export type StateEnv = {
  readonly APP_URL: string;
  readonly MAIL_SENDER?: Fetcher;
};
