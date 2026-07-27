# Backend implementation example

Fog's backend runs only on Cloudflare Workers and SQLite-backed Durable
Objects. Keep dependencies pointing inward:

```text
request/presentation
  -> application ports and primitive RPC DTOs
    -> domain invariants

state Worker Durable Objects
  -> Cloudflare adapters implementing application ports
    -> synchronous SQLite transaction / FTS projection
```

## Request boundary

The request Worker authenticates the session, validates transport input, and
derives the canonical `userId`. It calls an `AuthenticatedUserDataRouter`; a
form, URL, REST request, or future MCP request must never provide a Durable
Object ID or partition key.

Cross-Worker RPC uses structured-cloneable primitives and a versioned result
envelope:

```ts
type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SerializedError };
```

Mutating requests carry one stable operation ID. Retry only when the RPC error
is explicitly retryable, keep the same operation ID, bound exponential backoff,
and convert overload into an infrastructure error immediately.

## Durable Object mutation

Prepare work that can await before opening the transaction. Convert it to a
typed semantic command, then commit aggregate rows and search projection in the
same synchronous transaction:

```ts
const command = await prepareMemoUpdate(input);

const result = semanticCommit.transactionSync((tx) => {
  tx.memo.apply(command.memo);
  tx.searchProjection.upsert(command.search);
  return command.result;
});
```

The transaction callback must not return a Promise or perform crypto, RPC,
email, or other external I/O. `SearchProjectionPort` is transaction-scoped and
is not independently injectable into ordinary use cases.

## Persistent jobs and Alarms

External I/O and retention use a persistent User Data DO job. Store attempt,
`nextRunAt`, provider idempotency key, lease expiry, owner token, status, and
poison reason. Claim and read the earliest pending time in a synchronous
transaction; call `setAlarm` only after commit. Completion uses owner-token CAS.
An expired lease is reclaimable.

Domain events may represent an inward business/audit fact, but they are not an
Outbox transport. FTS is a local semantic projection and never rides a queue.

## Schema evolution

Each of the three DO classes has an independent `schema_migrations` table.
Activation runs forward-only idempotent migrations under the input gate. A
failure rolls back and retries on the next activation. Never assume all objects
have migrated immediately after deploying a new state Worker.

## Errors

- Validate shape/size at the transport or RPC boundary.
- Translate SQLite/Cloudflare errors in adapters.
- Let domain errors cross application use cases unchanged.
- Serialize structurally at the presentation/RPC boundary.
- Broad catches are reserved for per-job retry/poison handling.

## Verification

Use workerd integration tests with the request Worker and auxiliary state
Worker. Verify physical user isolation, RPC envelopes, lazy migration,
transaction rollback, FTS lifecycle, Alarm replay/reclaim, and identity saga
fault recovery against real Durable Object SQLite.
