# Testing

Three suites, split by **what has to be real** rather than by layer. A fast unit suite covers the pure parts; an integration suite runs inside a Workers isolate against real Durable Object SQLite, because transactions, OCC and FTS5 have no honest in-memory stand-in; a boot smoke suite starts the *built* bundle under workerd, because nothing else asks whether the shipped module graph evaluates at all.

## Test layer classification

### Unit (`pnpm test:unit`)

- **Targets**: domain-layer and application-layer logic (the pure parts), plus the pure helpers inside the Cloudflare adapter group — the job-convergence rules, the re-arm classification, `jobKind` / `jobBudgets` exhaustiveness, `directoryLocator`'s bucket-index derivation, `platform/stubErrors`' translation table, the search projection's normalisation.
- **Dependencies**: the only fakes kept on hand are the three under `packages/core/src/application/__tests__/fakes/`: `FakeIdGenerator` (a deterministic UUIDv7 stream), `FakeLogger` (a recording Logger), and `FakePasswordHasher` (a cheap deterministic digest). `Clock` can simply be passed to the usecase as a freestanding `now: Date`, and repository-style fakes are intentionally absent (the judgment being that imitating a transaction or OCC with an in-memory fake is no substitute for integration).
- **Speed**: a few to a dozen-or-so milliseconds. `vitest.config.ts` runs the Node pool and excludes `**/*.integration.test.ts`, so nothing here touches storage.
- **Naming**: `**/__tests__/<target>.test.ts` (e.g. `valueObject.test.ts`, `jobKind.test.ts`, `stubErrors.test.ts`).

### Integration (`pnpm test:integration`)

- **Targets**: everything that only exists inside a Durable Object — schema creation and the lazy migration gate, fail-closed behaviour, OCC, the FTS5 projection's same-transaction integrity, the `jobs` table's CAS / backoff / poison / lease reclaim, the Alarm's start-up semantics, and the identity RPC entry points end to end.
- **Dependencies**: real SQLite through a single Workers pool — `@cloudflare/vitest-pool-workers` with the two Durable Object namespaces bound. The bindings **must** declare `useSQLite: true`; the default backend is KV, where `ctx.storage.sql` does not exist, and the string shorthand cannot express the flag. `main` is a top-level pool option (not a `miniflare` one) and points at the state Worker entry, which is what lets the bindings resolve its exported classes.
- **Aim**: verify the things whose failure modes are storage-shaped — that `ConflictError("OPTIMISTIC_LOCK_FAILURE")` comes from a conditional `UPDATE … RETURNING 1` matching zero rows and never from another statement's result, that a commit moves the base row and the FTS5 index together or moves neither, and that a job's terminal state is written in one transaction.
- **Speed**: roughly 10× unit. Day to day you run `pnpm test:unit`, and run `pnpm test:integration` when you touch an adapter or before a PR.
- **Naming**: `**/__tests__/<target>.integration.test.ts`.

### Boot smoke (`pnpm test:smoke`)

- **Targets**: the build output, not the source. Both Workers (`dist/server/index.js` and `dist/state/index.js`).
- **Dependencies**: the Node pool driving Miniflare directly with `scriptPath`; run `pnpm build:cf` first.
- **Aim**: exactly two claims — the Worker answers a `dispatchFetch` at all (the status is not asserted), and starting it does not throw `Disallowed operation called within global scope`. Module-scope randomness, I/O and timers type-check, lint and pass every integration test; only workerd evaluating the shipped top level rejects them.
- **Naming**: `apps/web/__tests__/**/*.smoke.test.ts`.

### Property-based (fast-check)

- **Targets**: value-object invariants and edge cases that fail under random input.
- **Aim**: automatically verify properties such as canonicalisation being idempotent and length checks holding after the transform, over hundreds of samples. Keep custom arbitraries to the bare minimum.
- **Naming**: `**/__tests__/<target>.property.test.ts`.

## Fake policy

Currently the following three are the only fakes kept under `packages/core/src/application/__tests__/fakes/`:

- **`FakeIdGenerator`** — returns deterministic ids by embedding a counter into a UUIDv7 template. The output is shaped to pass the adapter-side rehydration validation (`IdGenerator.validate`), so it won't fail format checks even in round-trip tests through storage. The starting number can be fixed via the constructor, and the prefix is `ffffffff-...` so that generated ids sort after the test's fixed rows.
- **`FakeLogger`** — merely records each `info` / `warn` / `error` call into an `entries` array. Use `byLevel("error")` to extract them and assert on observability behaviour — including the forbidden-value checks, which walk everything a logger was handed and assert that no canonical address, HMAC, locator or token appears in it.
- **`FakePasswordHasher`** — a cheap deterministic digest, so integration suites don't pay a real key derivation per registration / login (the real algorithm is covered by the WebCrypto adapter's own unit tests, and a test that genuinely needs a PBKDF2 round trip injects `createPbkdf2PasswordHasher({ iterations })` at a low count instead — `identity.integration.test.ts`'s "round-trips a password through the real PBKDF2 hasher"). Its output deliberately does **not** embed the plaintext, and the suite that uses it asserts "no plaintext reached the stored verifier" against that value ("keeps the password plaintext out of the stored verifier"); a fake that prefixed the password would make the assertion hold by accident, so the same route is walked once with the shipped hasher.

The `FakePasswordHasher` case is the criterion for adding a fake at all: the port is a pure CPU-bound transform whose real implementation is separately unit-tested, and the fake preserves the one property the tests read off it. Fakes for repositories, the UoW, and the Clock are intentionally not kept.

- Even if you fake repositories or the UoW in-memory, you can't reproduce the adapter-derived behaviours that matter — a zero-row conditional `UPDATE`, an FTS5 external-content index going quietly stale, a transaction rolling both back. Logic tests for application services are better done at the integration layer, where they cover actual harm.
- `Clock` is just a `() => Date`, so it's enough to construct a constant like `new Date(0)` within a test and pass it to the usecase / domain. There's no need to fake it as a port object.

## Real storage test (integration) policy

- `pnpm test:integration` runs the whole suite in a **Workers isolate with the two Durable Object namespaces bound**. `vitest.config.integration.ts` owns the pool configuration, and `packages/core/src/adapters/cloudflare/__tests__/setup.ts` is the suite-wide `setupFiles`.
- **Cleanup is explicit, not automatic.** `isolatedStorage` does not exist in the installed `@cloudflare/vitest-pool-workers`, so nothing rolls a test's writes back. The setup file's `afterEach` calls `reset()` (deletes the data in every binding) and then `evictAllDurableObjects()` (intended to destroy the instances while keeping durable storage, which is what would clear in-memory state such as the alarm cache). Order matters — delete the data, then fold the instances. Measured against the installed version, only `reset()` is load-bearing: after it, a Durable Object comes back with its alarm cleared *and* re-arms on the next RPC, which a surviving alarm cache would have suppressed. `evictAllDurableObjects()` is kept as insurance against that changing.
- **Prefer a fresh Durable Object name per test.** Every suite but three derives one from a module-scope counter, and that — not the `afterEach` — is what actually makes them order-independent. The three fixed-name suites are `cleanup` (deliberately about reuse — it is what would go red if the cleanup ever stopped working), `gate` (names like `gate-ud-failclosed`, which carry schema state), and `binding` (`SELECT 1` only, so it holds nothing between runs). Use a fixed name only when the test is *about* reuse.
- `setupTestContainer()` (`packages/core/src/application/__tests__/helpers.ts`) builds a production-equivalent container from the bound namespaces by going through `createRequestContainer`, rather than reaching for `idFromName` itself. That keeps the Durable Object selection point where the architecture claims it is — one module, checkable by `grep` — and means the suites exercise the same wiring production does, stub-error translation included.
- File names are `*.integration.test.ts`. The unit `vitest.config.ts` excludes this pattern and runs only unit tests.
- The suffix alone is not enough to get a file run: `vitest.config.integration.ts` selects integration tests through an explicit `include` allow-list of directories. A new `*.integration.test.ts` outside those directories is excluded from the unit suite by its suffix **and** skipped by the integration suite for not matching `include` — it silently runs nowhere. When you add integration tests under a new directory, add it to `include` in the same change.
- When writing tests conscious of OCC, remember that the outcome is now single-valued: the conditional `UPDATE … RETURNING 1` either matches its row or matches nothing, and the zero-row case maps to `ConflictError("OPTIMISTIC_LOCK_FAILURE")` inside the statement that failed. Assertions can and should pin one outcome; a loose "either shape" assertion is no longer warranted.
- FTS5 uses an external-content index, where a wrong write raises no exception and only corrupts the index. Assert on the observable consequence — "searching the old value returns nothing after the update" — rather than on which statements were issued.

## Property-based policy

- fast-check is adopted mainly to verify **boundary values + invariants**.
- Before writing a custom arbitrary, consider whether existing `fc.string()` / `fc.integer()` plus `filter` suffice. Don't make the domain overly dependent on fast-check.

## Timeout / flakiness

- The unit and integration configs use Vitest's default timeouts; the smoke config raises them to 60s, because it starts two workerd instances rather than importing a module.
- Nothing between storage and the usecase retries on its own, so there is no retry backoff to tune. A conflict that reaches the caller is a signal, not a retry candidate. The one retry in the system belongs to the job runner and is asserted directly (attempt count, `next_run_at` growth, the transition to `poison`).
- Test order independence rests first on **name uniquing** — a per-test Durable Object name from a module-scope counter — and only then on the `afterEach` above, which covers the suites that reuse a fixed name. If a suite starts failing only when run with others, look for a fixed Durable Object name in it before suspecting the code. This is why CI runs the integration job through `pnpm test:integration:shuffle` rather than `pnpm test:integration` — same suite, same cost, but a different order every run, seeded with the GitHub run id so a red run reproduces locally with `--sequence.seed=<id>`. Run the shuffled variant yourself whenever you add a fixed Durable Object name or suspect an order dependence.

## Commands

| Purpose | Command |
| --- | --- |
| Unit + integration | `pnpm test` |
| Unit only | `pnpm test:unit` |
| Integration only (Workers pool + Durable Object SQLite) | `pnpm test:integration` |
| Integration in randomised order (what CI runs) | `pnpm test:integration:shuffle` |
| Boot smoke (needs `pnpm build:cf` first) | `pnpm test:smoke` |
| A single file or path pattern | `pnpm test:unit packages/core/src/domain/identity` |

## Coverage

Coverage numbers are not enforced. Rules of thumb:

- **Domain**: aim for ~100%. Logic is local and easy to fully cover, and a missing test translates directly into a broken invariant.
- **Application + Adapter (integration)**: per "representative path". Provide at least one for each route — OCC success / OCC failure, the projection's same-transaction integrity, a job's enqueue → run → done, a job's failure → backoff → poison, the migration gate's fail-closed branch. For usecase orchestration, prioritise confirming it "ran on real storage" over exhaustive coverage with fakes.
- **Frontend**: the bare minimum. The server function's wire-type boundary and UI logic are broadly covered by the behaviour of Zod and `useActionState` / `useOptimistic`.
