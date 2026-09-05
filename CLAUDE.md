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
- `apps/web` (`@repo/web`) — the TanStack Start app: routes, components, the presentation layer, Node server entry and workers, operation scripts, and Vite config.
- `infra/node` — configuration examples for the Node production process.
- Root — shared tooling only: Biome, vitest orchestration configs, delegating scripts. `@types/*` are publicly hoisted (see `pnpm-workspace.yaml`) so `.d.ts` files inside the pnpm store can resolve `react` / `vitest` types.

A future app (MCP server, CLI, …) is a new `apps/*` package that declares `"@repo/core": "workspace:*"` and owns its DI wiring or reuses one from `packages/core/src/application/di/`. No tsconfig `paths` mirror is needed.

## Development Commands

Run from the repo root — root scripts delegate to `@repo/web` where relevant:

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` / `pnpm lint:fix` / `pnpm format` / `pnpm format:check` (Biome, whole repo)
- `pnpm typecheck` (root `tsgo` for the vitest configs + `pnpm -r typecheck` across packages)
- `pnpm test` / `pnpm test:unit` / `pnpm test:integration` (vitest runs at the root, spanning `apps/web` and `packages/core`)
- Web-only scripts not delegated at the root: `pnpm --filter @repo/web <script>` (or run inside `apps/web`)

After changes: `pnpm typecheck && pnpm lint:fix && pnpm format`.

## Architecture

Hexagonal architecture with DDD. Dependencies point inward: presentation → application → domain, with adapters implementing ports defined inward of them.

### Layers

- **Domain** (`packages/core/src/domain/`) — Pure business logic: entities, value objects, domain services, port interfaces, domain events. No I/O, no framework, no ambient time / id generation. Throws `BusinessRuleError` for invariant violations.
- **Application** (`packages/core/src/application/`) — Use cases that orchestrate the domain. Defines ports for cross-cutting concerns (clock, id generation, logging), the unit-of-work abstraction, and application-level errors. DTO projection for the presentation layer lives here.
- **Adapters** (`packages/core/src/adapters/`) — Concrete implementations of ports per provider (DB, external APIs, etc). Translate driver-specific errors into the shared error contracts.
- **Presentation** (`apps/web/app/presentation/`) — Framework-specific cross-cutting utilities for TanStack Start: server-function entry point, error-response middleware, transport-boundary input validation, error display helpers. The full `SerializedError` union is assembled here from each layer's variants.

### Not a layer

- `packages/core/src/lib/` — Shared structural primitives (e.g. the `CodedError` base, structural pieces of the serialized-error contract) that every layer may extend. Living outside the layered tree is what lets all four layers depend on it without violating the inward-only direction.

### Frontend

TanStack Start with React 19 / RSC, TanStack Router (file-based routes), Tailwind v4. Components live under `apps/web/app/components/`, routes under `apps/web/app/routes/`. Default to async server components for data fetching and usecase invocation; use server functions (via the presentation-layer entry point) for mutations and loader bridges; drive client mutations through React 19 primitives directly rather than custom wrappers.

Mutations are a three-layer concern: server component fetches → `"use client"` island for interaction → React 19 primitives (`useActionState` / `useTransition` / `useOptimistic`) for instant feedback. The third layer is mandatory — a server function wired straight to a `<form>` with no optimistic/pending UI is the default failure mode that yields a sluggish, round-trip-only app.

Ownership follows the kind of change. **In-item mutations** (a field toggle, an inline rename) don't change list membership and the leaf survives them, so the leaf owns its server function, its item-local `useOptimistic`, and its error UI. **List-membership changes** (add/remove) can't use an item-local `useOptimistic` — they're a parent-state change — so move list ownership to a client island seeded by the loader (`apps/web/app/components/fog/TimelineBoard.tsx`) and have the owner run the server function for them. Delete in particular must run in the owner: the optimistic removal unmounts the leaf before the request settles, so a leaf-owned delete would discard its own error UI. Add is dispatched from the form's action because the form lives outside the list and survives the round trip. Every mutation reconciles with `router.invalidate()`; the optimistic list re-bases onto the refetched data. `apps/web/app/components/fog/` is the reference for all of this.

Loading fallbacks come in two kinds, by scope. **Per-fragment streaming** is for content tied 1:1 to a URL (lists, details): the loader forwards the `renderServerComponent(...)` promise **without awaiting** it, so navigation settles instantly and the fragment streams in under `<Suspense fallback={<Skeleton/>}>` (resolved client-side by `Deferred`/`use()`). `apps/web/app/routes/timeline.tsx` is the reference; skeletons live under `apps/web/app/components/ui/Skeleton` (generic) and `apps/web/app/components/fog/TimelineSkeleton.tsx` (shaped to the real DOM so it swaps in without layout shift). **Route-level pending** (`router.tsx`'s `defaultPendingComponent` + `defaultPendingMs`/`defaultPendingMinMs`) is the navigation fallback for any route whose loader genuinely *blocks*; a route that streams (like `/timeline`) settles its loader immediately and never triggers it. Keep the two roles distinct: skeletons cover the initial/streaming load, the optimistic primitives above cover post-mount mutations.

## Key concepts

Each of these is enforced in code and documented in library-level JSDoc at the relevant module — read there for the details.

- **Unit of Work** — every transactional usecase runs inside `FogUnitOfWorkProvider.run(fn)`; the context exposes the repositories the callback may touch. Revision writes, AI receipts, and reset mail enqueue occur in the same transaction as the associated state change.
- **Recovery mail outbox** — reset tokens and delivery payloads are persisted transactionally. The mail dispatcher claims rows under a lease, retries failures, and removes secret payloads after delivery or expiry. Delivery is at-least-once with a stable message ID.
- **Retry strategy** — driver-level transient errors are retried inside the adapter; application code never sees them. There is intentionally no application-level OCC retry decorator.
- **Input validation** — validated at exactly two points: the transport boundary (shape / DoS) and value-object construction (business invariants). Usecases trust the static type in between. On the frontend the transport boundary is the route's `validateSearch` (URL params) or `serverAction`'s `inputValidator` (client-posted payloads); `serverData` is **internal-only** and intentionally schemaless — never feed unvalidated external input through it.

## Error handling

- Errors are class hierarchies that each carry their own `kind`-tagged serialized form (`toSerialized()`). The presentation layer serializes structurally — no `instanceof` enumeration of concrete classes.
- HTTP status mapping is presentation-only, driven by the serialized `kind`. Errors themselves do not carry transport concerns.
- Avoid broad `try / catch` in ordinary application logic. Use it only at explicit boundaries (server-function serialization, per-row tolerance in workers).

### Cross-layer catch policy

- **adapter → application**: adapters catch driver-specific errors and translate them into the shared error contracts. Application code never sees provider-native errors.
- **domain → application**: domain errors flow through usecases unchanged. Do not re-translate at the usecase boundary — invariant violations and transport-shape violations are intentionally distinct kinds.
- **application → presentation**: the server-function boundary catches and serializes any thrown error structurally via its `kind`-tagged form. Usecases themselves do not serialize.
- **worker → root**: workers wrap per-row processing in `try / catch` for partial-failure tolerance. This is the only place a broad `catch` is expected in application-layer code.

## Runtime

Node.js + libSQL is the single production runtime. The Node entry is `apps/web/app/server.node.ts`, the production launcher is `apps/web/scripts/listen.node.mjs`, and schema migration is `apps/web/scripts/migrate.node.ts`. Fog retention and recovery mail runners live in `apps/web/app/worker/node`. Request context is wired by `packages/core/src/application/di/serverNode.ts`; fog usecases receive their own UoW and ports at boot.

Keep a single adopted runtime. Add a different target only for a concrete deployment requirement, with a separate adapter and entry point. Shared domain/application contracts remain inward-facing. Operational guidance is `docs/runtime_node.md` and `docs/backup_restore.md`.

## Examples

具体的な実装パターンは `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md` を参照。
