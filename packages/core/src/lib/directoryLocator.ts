/**
 * Where a canonical credential lives: which routing-key generation derived it,
 * which bucket it fell into, its full-length HMAC, and the Durable Object name
 * those three produce.
 *
 * The type is here, in `lib/`, rather than beside the resolver that computes
 * it. The signup saga and `RequestContainer` are application-layer and need to
 * name this shape; if it lived in `adapters/cloudflare/`, naming it would be an
 * `application → adapters` import, which is a reversed dependency. It qualifies
 * as a structural primitive on the usual test: a plain object of primitives,
 * with no behaviour and no dependency of its own.
 *
 * Two stages are encoded here on purpose. `bucketIndex` is a **routing**
 * decision and collisions in it are expected and harmless. `hmac` is
 * **identity** — it is what a mapping row is keyed by — and is never truncated.
 *
 * Producing one requires `DIRECTORY_ROUTING_SECRET`, which only the request
 * Worker holds; a Durable Object receives the result and never derives it.
 */
export type DirectoryLocator = Readonly<{
  generation: number;
  bucketIndex: number;
  /** Full length: 64 hex characters. */
  hmac: string;
  /** `dir:g{generation}:b{bucketIndex}`. */
  doName: string;
}>;
