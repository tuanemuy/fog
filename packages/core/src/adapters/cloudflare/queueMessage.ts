/**
 * The Cloudflare Queue message the Outbox relay publishes.
 *
 * **Five items, and that is the whole of it** (`spec/async/index.md`).
 * The other columns of the row are not carried — the message is not a
 * copy of the row. `aggregate_id` in particular stays behind: it is the
 * throttle window key, stable for one address across one window, so
 * carrying it would let someone correlate several DLQ messages back to a
 * single recipient.
 *
 * This type lives in the adapter layer rather than the application layer
 * because it is the shape of a Cloudflare Queue delivery: `routingKey`
 * and `ownerToken` are both delivery-machinery items belonging to neither
 * the domain nor the application.
 *
 * `routingKey` is the emitting DO's own locator (`_meta.self_locator`),
 * pushed by the relay at publish time — it exists on neither the row nor
 * the domain payload. Its granularity is deliberately coarse enough that
 * it does not name a person.
 *
 * `ownerToken` is a **reusable secret** and its presence here is the one
 * explicit exception to the hygiene rules: the call guard of the
 * send-materials RPC cannot hold without it. The price of that exception
 * is two prohibitions that hold regardless — never log a queue message as
 * a whole (`eventId` and `type` are the most a log may carry), and never
 * forward DLQ messages to an external monitoring or log-aggregation sink.
 */
export type OutboxQueueMessage = Readonly<{
  eventId: string;
  type: string;
  payload: unknown;
  routingKey: string;
  ownerToken: string;
}>;
