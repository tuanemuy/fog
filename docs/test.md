# Testing

Fog separates fast domain/application unit tests from workerd integration tests
that exercise the real SQLite Durable Object runtime.

## Test layers

### Unit (`pnpm test:unit`)

- Pure domain invariants, application coordinators/policies, transport
  validation, query normalization, and WebCrypto adapters.
- Files use `*.test.ts`; `vitest.config.ts` excludes integration tests.
- Prefer deterministic values and the existing id/logger/password-hasher fakes.
  Do not build an in-memory Durable Object/storage fake.

Property tests use `fast-check` for boundary values, state transitions,
normalization, and monotonic version/epoch invariants.

### Workerd integration (`pnpm test:integration`)

`vitest.config.integration.ts` runs the request test Worker with the state Worker
as an auxiliary Worker. Tests use real SQLite-backed Durable Objects and cover:

- all three class exports/bindings and lazy migration idempotency,
- physical isolation between different user IDs,
- primitive RPC envelopes/version compatibility and operation idempotency,
- signup/login fault recovery and directory key rotation,
- memo/document create, update, remove, and restore with atomic FTS projection,
- Japanese trigram and escaped short-query search,
- transaction rollback when either aggregate or projection work fails,
- Alarm lease reclaim, owner-CAS completion, poison handling, re-arming, restart,
  and provider idempotency,
- Account Home PITR refusal and restore-time tombstone/epoch checks.

Use `runDurableObjectAlarm` for Alarm delivery and `evictDurableObject` for
restart/migration tests. A synthetic auxiliary Worker may model
`.overloaded`/`.retryable` RPC failures. The local lifecycle CLI must call only
test-worker bindings and must never be exported from a production route.

## Fake policy

Keep fakes limited to deterministic cross-cutting ports whose real
implementations are separately tested:

- `FakeIdGenerator`
- `FakeLogger`
- `FakePasswordHasher`

SQLite transaction, RPC, Alarm, migration, and concurrency behavior belongs in
workerd integration tests. Do not imitate it with repository or Unit of Work
fakes.

## Commands

| Purpose | Command |
| --- | --- |
| All | `pnpm test` |
| Unit | `pnpm test:unit` |
| Workerd integration | `pnpm test:integration` |
| One unit path | `pnpm test:unit packages/core/src/domain/identity` |

Before review, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm deploy:staging:dry
```

PITR itself is unavailable in local workerd. Follow the disposable staging
smoke in `runtime_cloudflare.md`; local tests verify only the operator wrapper
contract and Account Home refusal.
