# CLAUDE.md

Guidance for Claude Code working in this repository.

## Principles

- Prioritize type safety; lean on TypeScript's type system fully.
- Prefer stateless, pure functional code in domain / application layers. Adapter classes are fine when they encapsulate a single external resource and keep mutable state internal.
- Make illegal states unrepresentable at the type level before falling back to runtime checks.
- Default to no comments. Add one only when the WHY is non-obvious — a hidden constraint, an invariant, a workaround. Library-level JSDoc on exported APIs is welcome.
- Validate at the boundaries (transport in, value-object construction); trust the static type in between.
- Keep cross-cutting concerns (clock, id generation, logging) behind ports so domain and application code stays deterministic and testable.

## Workspace layout

pnpm monorepo. One lockfile at the root; packages resolve each other via package `exports` pointing straight at `.ts` sources (no build step for internal packages). `@repo/core` exposes a single flat rule — `"./*": "./src/*.ts"` — so every subpath maps 1:1 to a file and there is no barrel to import from.

- `packages/core` (`@repo/core`) — domain / application / adapters + shared `lib/` primitives. Framework-free; imported everywhere as `@repo/core/*`.
- `apps/web` (`@repo/web`) — the TanStack Start app: routes, components, the presentation layer, the Cloudflare request-Worker entry and the state Worker (`app/worker/cloudflare/state.ts`, which exports the two Durable Object classes defined under `app/durable-objects/`), `scripts/`, and all runtime configs (vite / wrangler).
- `infra/cloudflare/pulumi` (`@repo/infra-cloudflare`) — Pulumi resources and Wrangler-config rendering.
- Root — shared tooling only: Biome, vitest orchestration configs, delegating scripts. `@types/*` are publicly hoisted (see `pnpm-workspace.yaml`) so `.d.ts` files inside the pnpm store can resolve `react` / `vitest` types.

A future app (MCP server, CLI, …) is a new `apps/*` package that declares `"@repo/core": "workspace:*"` and owns its DI wiring or reuses one from `packages/core/src/application/di/`. No tsconfig `paths` mirror is needed.

## Development Commands

Run from the repo root — root scripts delegate to `@repo/web` where relevant:

- `pnpm dev` / `pnpm build` / `pnpm start` / `pnpm preview` (`pnpm dev` boots both Workers — the state Worker runs as an auxiliary worker of the same vite server; `pnpm start` / `pnpm preview` serve the build output and run the request Worker alone, so pair them with `pnpm dev:state` for flows that reach a Durable Object)
- `pnpm lint` / `pnpm lint:fix` / `pnpm format` / `pnpm format:check` (Biome, whole repo)
- `pnpm typecheck` (root `tsgo` for the vitest configs + `pnpm -r typecheck` across packages)
- `pnpm test` / `pnpm test:unit` / `pnpm test:integration` / `pnpm test:smoke` (vitest runs at the root, spanning `apps/web` and `packages/core`; `test:smoke` boots the build output under workerd, so run `pnpm build:cf` first)
- `pnpm deploy:{staging,production}` deploys both Workers, state first — the request Worker's DO bindings name the state Worker's script
- Web-only scripts not delegated at the root: `pnpm --filter @repo/web <script>` (or run inside `apps/web`)

After changes: `pnpm typecheck && pnpm lint:fix && pnpm format`.

## Architecture

Hexagonal architecture with DDD. Dependencies point inward: presentation → application → domain, with adapters implementing ports defined inward of them.

### Layers

- **Domain** (`packages/core/src/domain/`) — Pure business logic: entities, value objects, domain services, port interfaces. No I/O, no framework, no ambient time / id generation. Throws `BusinessRuleError` for invariant violations.
- **Application** (`packages/core/src/application/`) — Use cases that orchestrate the domain. Defines ports for cross-cutting concerns (clock, id generation, logging), the unit-of-work abstraction, and application-level errors. DTO projection for the presentation layer lives here.
- **Adapters** (`packages/core/src/adapters/`) — Concrete implementations of ports per provider (DB, external APIs, etc). Translate driver-specific errors into the shared error contracts.
- **Presentation** (`apps/web/app/presentation/`) — Framework-specific cross-cutting utilities for TanStack Start: server-function entry point, error-response middleware, transport-boundary input validation, error display helpers. The full `SerializedError` union is assembled here from each layer's variants.

### Not a layer

- `packages/core/src/lib/` — Shared structural primitives (e.g. the `CodedError` base, structural pieces of the serialized-error contract) that every layer may extend. Living outside the layered tree is what lets all four layers depend on it without violating the inward-only direction.

### Frontend

TanStack Start with React 19 / RSC, TanStack Router (file-based routes), Tailwind v4. Components live under `apps/web/app/components/`, routes under `apps/web/app/routes/`. Default to async server components for data fetching and usecase invocation; use server functions (via the presentation-layer entry point) for mutations and loader bridges; drive client mutations through React 19 primitives directly rather than custom wrappers.

Mutations are a three-layer concern: server component fetches → `"use client"` island for interaction → React 19 primitives (`useActionState` / `useTransition` / `useOptimistic`) for instant feedback. The third layer is mandatory — a server function wired straight to a `<form>` with no optimistic/pending UI is the default failure mode that yields a sluggish, round-trip-only app.

The shipped references are `apps/web/app/components/auth/{LoginForm,SignupForm}` (form submission through `useActionState`) and `apps/web/app/components/settings/LogoutButton` (an out-of-form action through `useTransition`).

Ownership follows the kind of change. **In-item mutations** (a field toggle, an inline rename) don't change list membership and the leaf survives them, so the leaf owns its server function, its item-local `useOptimistic`, and its error UI. **List-membership changes** (add/remove) can't use an item-local `useOptimistic` — they're a parent-state change — so move list ownership to a client island seeded by the loader and have the owner run the server function for them. Delete in particular must run in the owner: the optimistic removal unmounts the leaf before the request settles, so a leaf-owned delete would discard its own error UI. Add is dispatched from the form's action because the form lives outside the list and survives the round trip. Every mutation reconciles with `router.invalidate()`; the optimistic list re-bases onto the refetched data. No screen owns a list yet, so this half of the rule has no reference implementation — `useOptimistic` appears nowhere in `apps/web/app/`; `docs/frontend_implementation_example.md` carries the worked example.

Loading fallbacks come in two kinds, by scope. **Per-fragment streaming** is for content tied 1:1 to a URL (lists, details): the loader forwards the `renderServerComponent(...)` promise **without awaiting** it, so navigation settles instantly and the fragment streams in under `<Suspense fallback={<Skeleton/>}>` (resolved client-side by `Deferred`/`use()`). `apps/web/app/routes/_app/settings.tsx` is the reference; skeletons live under `apps/web/app/components/ui/Skeleton` (generic) and `apps/web/app/components/settings/SettingsSkeleton` (shaped to the real DOM so it swaps in without layout shift). **Route-level pending** (`router.tsx`'s `defaultPendingComponent` + `defaultPendingMs`/`defaultPendingMinMs`) is the navigation fallback for any route whose loader stays unresolved past the threshold. A streaming route is not automatically exempt: `/settings`'s loader awaits the `createServerFn` call that hands over the unresolved promise, which is free under SSR but costs one `/_serverFn/...` round trip on client navigation. If that hop is slower than `defaultPendingMs`, the route-level pending shows first and the fragment skeleton after (measured at 253ms with 1500ms injected into the handler). Add `pendingComponent: () => null` to a streaming route if you want its skeleton to be the only fallback. Keep the two roles distinct: skeletons cover the initial/streaming load, the optimistic primitives above cover post-mount mutations.

## Key concepts

Each of these is enforced in code and documented in library-level JSDoc at the relevant module — read there for the details.

- **Unit of Work** — every transactional usecase runs inside `UnitOfWorkProvider.run(fn)`, and the callback is **fully synchronous**. The signature `run<T>(fn: (ctx: UnitOfWorkContext) => T extends Promise<unknown> ? never : T): T` type-rejects `async` callbacks, which turns "no `await` inside a transaction" from a convention into a language rule. `run` takes no scope argument: the Durable Object is the scope, and `userId` was already consumed when its stub was selected. The context exposes the aggregate repositories the callback may touch, the non-aggregate stores — **whose roster differs by DO class**: the User Data DO exposes `credentialLocatorStore`, the Identity Directory DO exposes `resetTokenStore` (`PasswordResetTokenPort` on the domain side) and `rotationCheckpointStore` — and the in-transaction side-effect registration points, which likewise differ by DO class: both classes expose `enqueueJob`, while `recordOperation` / `updateOperation` / `setMigrationCursor` exist only on the User Data DO, since `operations` and `migration_progress` live there. Those two groups are the **complete set** of write paths into the non-aggregate stores — `operations` is the only one reached by two methods, and `_meta` has none, since only the adapter writes it and no usecase may reach `schema_version`. `account` is not on that roster — it carries the OCC `version` column and is reached from the aggregate side, even though the domain names its port `AccountStore`. The per-table roster, and its count, lives in `spec/database/index.md`. Never put an asynchronous port on the context (`MailSender`, `PasswordHasher`, a DO stub factory, anything carrying `fetch`), and never call `run` from inside `run`.
- **Retry strategy** — nothing between storage and usecase retries on its own. OCC is enforced by a conditional `UPDATE` guarded on `version` — plus `id` where the table has one; the single-row `account` / `user_settings` have none, so `version` alone conditions them (`spec/database/index.md` is the authority on the per-table form). Its matched-row count is read back, and a mismatch is a caller-visible signal rather than a retry candidate: `ConflictError("OPTIMISTIC_LOCK_FAILURE")` reaches the usecase and, from there, the transport boundary. There is intentionally no application-level OCC retry decorator. Retry exists in exactly one place — the job runner (see below) — and is never delegated to the platform.
- **Input validation** — validated at exactly two points: the transport boundary (shape / DoS) and value-object construction (business invariants). Usecases trust the static type in between. On the frontend the transport boundary is the route's `validateSearch` (URL params) or `serverAction`'s `inputValidator` (client-posted payloads); `serverData` is **internal-only** and intentionally schemaless — never feed unvalidated external input through it. The RPC hop into a Durable Object is **not** a third point: facade signatures take primitives only (branded types do not survive structured clone), and the value objects are rebuilt inside the DO — that reconstruction *is* the second point.
- **Storage limits** — one Durable Object holds a single user's data, capped at 10 GB counting the base tables and the FTS5 index together. The SQLite limits that shape the schema are 100 columns per table, 2 MB per row, 100 KB per statement and 100 bind parameters — the last is why bulk inserts are chunked. Near the cap a DO half-dies: writes fail while reads and `DELETE` still succeed, which is what keeps the recovery paths (empty the trash, export and delete) usable.

### Asynchronous execution contract

Every effect that cannot complete inside a transaction obeys this contract.

1. **There is no domain-event transport.** Effects that do complete inside the transaction — the FTS5 projection, retention hard-deletes, saga phase advances — are performed directly in that `transactionSync`.
2. **Work that performs external I/O must ride a durable job**, since it cannot run inside a transaction. That is a sufficient condition, not the full population: expiry processing, checkpointed bulk work and cross-DO saga advancement use the same `jobs` table and Alarm. The four kinds below cover every `jobs.kind` exactly once; **adding a `kind` means adding it here too** (the per-table list lives in `spec/database/index.md`).

   | Kind of work | `jobs.kind` |
   |---|---|
   | External I/O | `send-mail` |
   | Expiry processing | `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` |
   | Checkpointed bulk work | `reindex` / `migrate-bulk` / `rotate-encryption` |
   | Cross-DO saga advancement | `finalize-withdrawal` / `resume-link` / `resume-signup` / `resume-credential-change` / `sweep-orphan-mapping` |

   Only `send-mail` reaches outside; the other eleven are DO-local.
3. **Job execution is at-least-once.** A DO has one Alarm, which walks its `jobs` rows in `nextRunAt` order, and the DO can reset immediately after a send succeeded — so **every job implementation must be idempotent**. External providers receive a `providerIdempotencyKey` derived deterministically from the job's `operationKey`.
4. **There is no ordering guarantee between jobs.** Failures are pushed out by backoff, and jobs in different DOs share neither a clock nor a queue. Never write a design that depends on the relative order of two different job kinds; express ordering with state-machine phases and CAS conditions instead.
5. **Retry belongs to the job runner, not to the platform.** Never throw out of `alarm()`. Catch each job's failure, advance its `attempt` and `nextRunAt`, and once the limit is passed mark the row `poison` with a `terminalReason` for operator escalation. This is the one broad catch allowed under "worker → root" below.
6. **OCC conflicts are not retried** — see "Retry strategy" above. The conflict travels out to the transport boundary (or into the job's `terminalReason`) unswallowed.
7. **Cross-request idempotency keys never come from the client.** `operationId` is minted server-side; cross-request idempotency is carried by the directory reservation rows and `credential_mappings.changeState`.

## Error handling

- Errors are class hierarchies that each carry their own `kind`-tagged serialized form (`toSerialized()`). The presentation layer serializes structurally — no `instanceof` enumeration of concrete classes.
- HTTP status mapping is presentation-only, driven by the serialized `kind`. Errors themselves do not carry transport concerns.
- Avoid broad `try / catch` in ordinary application logic. Use it only at explicit boundaries (server-function serialization, the Durable Object's RPC entry points, per-job tolerance in the job runner, the fail-closed migration gate inside `alarm()`).
- Errors cross the request Worker ↔ Durable Object boundary as a value envelope (`{ ok: true, value } | { ok: false, error: SerializedError }`), never as a thrown custom class — RPC does not preserve the structural serialization contract. The DO's RPC entry catches and returns `toSerialized()`; the calling adapter additionally translates platform failures raised by the stub call itself (the DO was unreachable or died), since those never enter the envelope. Both are folded into the same `SerializedError` before reaching the error-response middleware.

### Cross-layer catch policy

- **adapter → application**: adapters catch driver-specific errors and translate them into the shared error contracts. Application code never sees provider-native errors.
- **domain → application**: domain errors flow through usecases unchanged. Do not re-translate at the usecase boundary — invariant violations and transport-shape violations are intentionally distinct kinds.
- **application → presentation**: the server-function boundary catches and serializes any thrown error structurally via its `kind`-tagged form. Usecases themselves do not serialize.
- **worker → root**: the job runner wraps each job in `try / catch` so that one failing job neither aborts the rest of the queue nor escapes `alarm()`.
- **migration gate → `alarm()`**: the schema-version gate is fail-closed, and `alarm()` must never throw, so the gate call inside `alarm()` is wrapped as well. It is a distinct point from the job runner's per-job catch: this one runs before any job is claimed, and it deliberately leaves the alarm armed instead of calling `deleteAlarm()`, so a DO running behind its code recovers on the next deploy rather than going silent.

## Reference runtime

The template targets Cloudflare Workers with per-user SQLite-backed Durable Objects — no shared relational database, no managed queue, no external search service. Two Workers: a request Worker that serves HTTP and does the CPU-bound work (password hashing, token signing, export rendering and zipping), and a state Worker that owns the Durable Object classes. Each user's domain data lives in its own **User Data DO**, including the FTS5 search index, which is maintained in the same transaction as the data it indexes. Credentials live in bucketed **Identity Directory DOs**. Asynchronous work runs on the `jobs` table and each DO's Alarm, under the contract above. Storage layout and migrations are specified in `spec/database/index.md`.

Tenant isolation is structural rather than columnar: there is no `user_id` predicate that could be forgotten, because no code path can obtain another user's DO stub.

**This is a deliberate lock-in, and it reaches the inward layers.** `.adr/002` accepted Cloudflare as the target; `transactionSync` is what makes the cost concrete. Domain port contracts are synchronous — `TransactionalRepository` and the repositories return values, not promises. `PasswordHasher` / `MailSender` are the only asynchronous ports, and that list is an enumeration, not a derived rule: they stay asynchronous because the only APIs that can implement them are asynchronous, not because they run outside a transaction (`ArchiveWriter.write` runs outside the DO and is still synchronous). A runtime whose storage API is asynchronous cannot implement those ports as written. So targeting a different runtime (Bun, Fly Machines, …) still means a new adapter group under `packages/core/src/adapters/{provider}/` plus a paired entry point, but budget for revisiting the port contracts as well: the swap is not confined to `adapters/` and the entry points.

Entry points:

- Request Worker: `apps/web/app/server.cloudflare.ts` (fetch), wired by `packages/core/src/application/di/serverCloudflare.ts`.
- State Worker: `apps/web/app/worker/cloudflare/state.ts`, which exports `apps/web/app/durable-objects/{userData,identityDirectory}.ts`. Each class builds its container from `packages/core/src/application/di/stateCloudflare.ts`.

Each Worker has its own wrangler config (`apps/web/wrangler.toml` / `wrangler.state.toml` locally, four `wrangler.<role>.<stage>.toml.tpl` for deploys) and its own, non-overlapping set of secrets — `apps/web/.dev.vars.example` states which belongs to which and why. Durable Object namespaces are declared by the state Worker's `exports` block, not provisioned by Pulumi.

Operational guidance lives in `docs/runtime_cloudflare.md`. `pnpm dev` / `pnpm build` / `pnpm start` are aliases of their `:cf` counterparts.

## Examples

具体的な実装パターンは `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md` を参照。**`docs/backend_implementation_example.md` は D1 + Outbox 時代の例のまま**であり、書き換えは #38 が担当する — 現行構成の手本としては読まないこと。
