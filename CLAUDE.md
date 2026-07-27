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
- `apps/web` (`@repo/web`) — the TanStack Start app: routes, components, presentation, request/state Worker entries, Durable Object classes, scripts, and Wrangler/Vite configuration.
- `infra/cloudflare/pulumi` (`@repo/infra-cloudflare`) — Cloudflare DNS/custom-domain resources and stage-config rendering.
- Root — shared tooling only: Biome, vitest orchestration configs, delegating scripts. `@types/*` are publicly hoisted (see `pnpm-workspace.yaml`) so `.d.ts` files inside the pnpm store can resolve `react` / `vitest` types.

A future app (MCP server, CLI, …) is a new `apps/*` package that declares `"@repo/core": "workspace:*"` and owns its DI wiring or reuses one from `packages/core/src/application/di/`. No tsconfig `paths` mirror is needed.

## Development Commands

Run from the repo root — root scripts delegate to `@repo/web` where relevant:

- `pnpm dev` / `pnpm build` / `pnpm start` (Cloudflare request + state Workers)
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

The shipped references are `apps/web/app/components/auth/{LoginForm,SignupForm}` (form submission through `useActionState`) and `apps/web/app/components/settings/LogoutButton` (an out-of-form action through `useTransition`).

Ownership follows the kind of change. **In-item mutations** (a field toggle, an inline rename) don't change list membership and the leaf survives them, so the leaf owns its server function, its item-local `useOptimistic`, and its error UI. **List-membership changes** (add/remove) can't use an item-local `useOptimistic` — they're a parent-state change — so move list ownership to a client island seeded by the loader and have the owner run the server function for them. Delete in particular must run in the owner: the optimistic removal unmounts the leaf before the request settles, so a leaf-owned delete would discard its own error UI. Add is dispatched from the form's action because the form lives outside the list and survives the round trip. Every mutation reconciles with `router.invalidate()`; the optimistic list re-bases onto the refetched data. No screen owns a list yet, so this half of the rule has no reference implementation — `useOptimistic` appears nowhere in `apps/web/app/`; `docs/frontend_implementation_example.md` carries the worked example.

Loading fallbacks come in two kinds, by scope. **Per-fragment streaming** is for content tied 1:1 to a URL (lists, details): the loader forwards the `renderServerComponent(...)` promise **without awaiting** it, so navigation settles instantly and the fragment streams in under `<Suspense fallback={<Skeleton/>}>` (resolved client-side by `Deferred`/`use()`). `apps/web/app/routes/_app/settings.tsx` is the reference; skeletons live under `apps/web/app/components/ui/Skeleton` (generic) and `apps/web/app/components/settings/SettingsSkeleton` (shaped to the real DOM so it swaps in without layout shift). **Route-level pending** (`router.tsx`'s `defaultPendingComponent` + `defaultPendingMs`/`defaultPendingMinMs`) is the navigation fallback for any route whose loader stays unresolved past the threshold. A streaming route is not automatically exempt: `/settings`'s loader awaits the `createServerFn` call that hands over the unresolved promise, which is free under SSR but costs one `/_serverFn/...` round trip on client navigation. If that hop is slower than `defaultPendingMs`, the route-level pending shows first and the fragment skeleton after (measured at 253ms with 1500ms injected into the handler). Add `pendingComponent: () => null` to a streaming route if you want its skeleton to be the only fallback. Keep the two roles distinct: skeletons cover the initial/streaming load, the optimistic primitives above cover post-mount mutations.

## Key concepts

Each of these is enforced in code and documented in library-level JSDoc at the relevant module — read there for the details.

- **Semantic commit** — Durable Object mutations prepare a typed command asynchronously, then commit aggregate state and the FTS projection together inside one synchronous SQLite transaction. Never pass a transaction closure over RPC.
- **Domain events vs. jobs** — domain events are inward business/audit facts, not a transport. Local projections update synchronously. Retention and external I/O use persistent User Data DO jobs driven by one Alarm with at-least-once, lease, owner-CAS, and poison semantics.
- **Durable Object partitioning** — a canonical authenticated `userId` selects exactly one User Data DO. Identity Directory sharding uses request-side secret HMAC routing; public input never supplies a DO ID or partition key.
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
- **Alarm job → root**: the persistent job runner may catch per-job failures for retry/poison handling. This is the only place a broad `catch` is expected in application-layer code.

## Runtime

Fog targets Cloudflare Workers and SQLite-backed Durable Objects only:

- `apps/web/app/server.cloudflare.ts` is the public request Worker.
- `apps/web/app/server.state.ts` exports `UserDataDurableObject`, `IdentityDirectoryDurableObject`, and `AccountHomeDurableObject`.
- `apps/web/wrangler.request.toml` is the primary local Worker config; `apps/web/wrangler.state.toml` is the secondary config. `pnpm dev` launches both in one multi-config Wrangler process.
- The request Worker alone receives `SESSION_SECRET` and directory-routing secrets. The state Worker config explicitly filters them out.
- Each DO performs forward-only, idempotent lazy schema migration on activation. Class lifecycle uses declarative Wrangler `exports` with `storage = "sqlite"`.
- `infra/cloudflare/pulumi` manages DNS/custom-domain resources only. Durable Object namespaces are managed by the state Worker config.

Operational guidance lives in `docs/runtime_cloudflare.md`.

## Examples

具体的な実装パターンは `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md` を参照。
