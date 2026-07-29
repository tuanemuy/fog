# Testing

Tests are classified along two axes: **layer × purpose**. By separating a fast unit layer from an integration layer that verifies concurrent / OCC behavior against a real DB, we keep the day-to-day development loop light while continuously covering adapter pitfalls.

## Test layer classification

### Unit (`pnpm test:unit`)

- **Targets**: domain-layer + application-layer logic (the pure parts).
- **Dependencies**: the only fakes kept on hand are the three under `packages/core/src/application/__tests__/fakes/`: `FakeIdGenerator` (a deterministic UUIDv7 stream), `FakeLogger` (a recording Logger), and `FakePasswordHasher` (a cheap deterministic digest). `Clock` can simply be passed to the usecase as a freestanding `now: Date`, and repository-style fakes are intentionally absent (the judgment being that imitating transaction / OCC with an in-memory fake is no substitute for integration). We don't aim to exhaustively cover application-layer logic with fakes; behavior verification is pushed onto integration tests.
- **Aim**: invariants of the domain layer (value object / entity / events decoding), error-code branching, and the behavior of pure application-layer helpers like `outboxPrune`'s retention window.
- **Speed**: a few to a dozen-or-so milliseconds. `vitest.config.ts` excludes `**/*.integration.test.ts`, so nothing here touches a DB.
- **Naming**: `**/__tests__/<target>.test.ts` (e.g. `entity.test.ts`, `eventDecoders.test.ts`, `outboxPrune.test.ts`).

### Integration (`pnpm test:integration`)

- **Targets**: the Drizzle SQLite adapter implementation, adapter × application integration, concurrent / OCC (optimistic concurrency control) scenarios, and outbox poll / dispatch behavior.
- **Dependencies**: real SQLite through a single Workers pool — an in-memory Miniflare D1 binding.
- **Aim**: realistically verify batch rollback, `ConflictError("OPTIMISTIC_LOCK_FAILURE")` (raised from the `_occ_guard` CHECK when an OCC-guarded write matches zero rows), and the outbox's `claimPending` / `finalize`.
- **Speed**: roughly 10× unit. Day to day you run `pnpm test:unit`, and run `pnpm test:integration` when you touch an adapter or before a PR.
- **Naming**: `**/__tests__/<target>.integration.test.ts` (e.g. `identity.integration.test.ts`, `userRepository.integration.test.ts`, `outboxRepository.integration.test.ts`).

### Property-based (fast-check)

- **Targets**: value-object invariants, entity state transitions, and edge cases that fail under random input.
- **Dependencies**: `fast-check` (devDependency).
- **Aim**: automatically verify properties such as "if the post-trim length is 1-140 it is always accepted", "`complete` → `reopen` returns to the original active state", and "change status is idempotent for the same input" over hundreds of samples.
- **When to use**: boundary values (TitleEmpty / TitleTooLong), state transitions (active ⇄ completed), invariants (monotonic increase of `version`). Keep custom arbitraries to the bare minimum, and use combinations of `fc.string()` / `fc.integer()` for anything that can be written that way.
- **Naming**: `**/__tests__/<target>.property.test.ts` (e.g. `valueObject.property.test.ts`, `entity.property.test.ts`).

## Fake policy

Currently the following three are the only fakes kept under `packages/core/src/application/__tests__/fakes/`:

- **`FakeIdGenerator`** — returns deterministic ids by embedding a counter into a UUIDv7 template. The output is shaped to pass the adapter-side rehydration validation (`IdGenerator.validate`), so it won't fail format checks even in round-trip tests through storage. The starting number can be fixed via the constructor, and the prefix is `ffffffff-...` so that generated ids sort after the test's fixed rows (they come after the `01950000-...` series when sorting by `(createdAt, id)`).
- **`FakeLogger`** — merely records each `info` / `warn` / `error` call into an `entries` array. Use `byLevel("error")` to extract them and assert on the observability behavior of the relay worker / usecase.
- **`FakePasswordHasher`** — a cheap deterministic digest, so integration suites don't pay a real key derivation per registration / login (the real algorithm is covered by the WebCrypto adapter's own unit tests, and a test that genuinely needs a PBKDF2 round trip injects `createPbkdf2PasswordHasher({ iterations })` at a low count instead). Its output deliberately does **not** embed the plaintext: every suite using it asserts "no plaintext reached `users.password_hash`" against that value, and a fake that prefixed the password would make the assertion hold by accident.

The `FakePasswordHasher` case is the criterion for adding a fake at all: the port is a pure CPU-bound transform whose real implementation is separately unit-tested, and the fake preserves the one property the tests read off it. Fakes for repositories, the UoW, and the Clock are intentionally not kept.

- Even if you fake repositories / the UoW in-memory, you can't reproduce the essential adapter-derived behaviors like the deferred batch flush or `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. Logic tests for application services are better done at the integration layer (real SQLite), where they cover actual harm.
- `Clock` is just a `() => Date`, so it's enough to construct a constant like `new Date(0)` within a test and pass it to the usecase / domain. There's no need to fake it as a port object.

## Real DB test (integration) policy

- `pnpm test:integration:cf` runs D1/application/Cloudflare-worker tests against a **Workers isolate + Miniflare D1 binding** via `vitest-pool-workers`. `vitest.config.integration.ts` handles the pool configuration, and `packages/core/src/adapters/d1/__tests__/setup.ts` handles applying migrations and the `beforeEach` TRUNCATE.
- `setupTestContainer()` (`packages/core/src/application/__tests__/helpers.ts`) returns a production-equivalent, D1-backed container from `env.DB`. Cross-test state cleanup is handled by the global setup, so the helper is just a factory + getter.
- File names are `*.integration.test.ts`. The unit `vitest.config.ts` excludes this pattern and runs only unit tests.
- The suffix alone is not enough to get a file run: `vitest.config.integration.ts` selects integration tests through an explicit `include` allow-list of directories. A new `*.integration.test.ts` outside those directories is excluded from the unit suite by its suffix **and** skipped by the integration suite for not matching `include` — it silently runs nowhere. When you add integration tests under a new directory, add it to `include` in the same change.
- When writing tests that are conscious of concurrent / OCC, use patterns such as firing `run` simultaneously with `Promise.all` and observing `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. In D1's deferred-batch UoW, a race branches such that one side hits a CHECK violation on `_occ_guard` and the other gets an empty batch, so keep assertions loose enough to pass under either failure shape for stability.

## Property-based policy

- fast-check is adopted mainly to verify **boundary values + invariants**.
- It's useful for property checks such as each domain value-object factory, entity state transitions (`complete` → `reopen` returns to the active state, the idempotency where repeating `rename` with the same value doesn't increment version, etc.), and the idempotency of set-style usecases.
- Before writing a custom arbitrary, consider whether existing `fc.string()` / `fc.integer()` plus `filter` suffice. Don't make the domain overly dependent on fast-check.

## Timeout / flakiness

- The configs currently use Vitest's default timeouts. Unit tests finish in a few hundred milliseconds; if an integration test needs a longer ceiling, set it in `vitest.config.integration.ts` rather than slowing the unit suite.
- The D1 adapter has **no** built-in transient retry, so there is no retry backoff to tune. `SQLITE_BUSY` / `SQLITE_LOCKED` are connection-level conditions the D1 binding handles upstream of the adapter, and whatever still reaches the caller is a signal, not a retry candidate (`packages/core/src/adapters/d1/unitOfWork.ts`).
- Four integration tests run work concurrently today, and each pins a single deterministic outcome rather than a range: the registration race in `identity.integration.test.ts` (the loser always surfaces as a `UNIQUE_VIOLATION`, since D1 aborts its batch), two competing `claimPending` callers in `outboxRepository.integration.test.ts`, three competing `markProcessed` calls in `idempotencyStore.integration.test.ts`, and a pair of concurrent reads in `userRepository.integration.test.ts`. Nothing races two OCC-guarded writes yet — that is the one shape with two possible failures (see "Real DB test (integration) policy" above), so a new test of that kind should assert loosely enough to accept both before reaching for per-test `test.extend` / `vi.useFakeTimers`.

## Commands

| Purpose | Command |
| --- | --- |
| All | `pnpm test` |
| Unit only | `pnpm test:unit` |
| Integration only (Workers pool + D1) | `pnpm test:integration` (alias of `pnpm test:integration:cf`) |
| A single file or path pattern | `pnpm test:unit packages/core/src/domain/identity` |

## Coverage

Coverage numbers are not enforced. Rules of thumb:

- **Domain**: aim for ~100%. Logic is local and easy to fully cover, and a missing test translates directly into a broken invariant.
- **Application + Adapter (integration)**: per "representative path". Provide at least one for each route, such as OCC success / OCC failure, same-tx placement of the outbox, per-row isolation of relay-worker decode failures, and the race of a concurrent delete. For usecase orchestration coverage, prioritize confirming it "ran on a real DB" via integration over exhaustive coverage with fakes.
- **Frontend**: the bare minimum. The server function's wire-type boundary and UI logic are broadly covered by the behavior of Conform / Zod and `useActionState` / `useOptimistic`.
