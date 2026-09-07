import type { StateWorkerEnv } from "@repo/core/adapters/cloudflare/durableObjectBase";
import type * as stateEntry from "./state";

/**
 * Type-level assertions that hold `worker-configuration.state.d.ts` — the
 * `wrangler types` output for `wrangler.state.toml` — against the state
 * Worker's entry point and the bindings its Durable Objects receive.
 *
 * `tsconfig.state.json` is the only program that reads this file and the
 * generated one: both declare `Cloudflare.GlobalProps.mainModule` and
 * `StringifyValues`, so holding the request-side and state-side outputs in
 * one program is a TS2717 / TS2300 collision, and `StateEnv` is a global
 * interface that no module can import.
 *
 * **Limit**: `wrangler types` fills the secret entries of the generated
 * interface from the local, gitignored `.dev.vars`, so those entries differ
 * per machine and are not asserted here — only entries that
 * `wrangler.state.toml` itself determines are.
 */
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

export type DurableNamespacesAreExportedByStateEntry = Assert<
  Extends<Cloudflare.GlobalProps["durableNamespaces"], keyof typeof stateEntry>
>;

export type EventsQueueBindingMatchesStateWorkerEnv = Assert<
  Extends<StateEnv["EVENTS_QUEUE"], StateWorkerEnv["EVENTS_QUEUE"]>
>;
