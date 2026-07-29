# tanstack-start-template

A reference template for building applications with **TanStack Start + React 19 (RSC)** on a **DDD / Hexagonal architecture** foundation.

The goal is to give you a worked example of:

- file-based routing and server components as the default data-fetching path,
- a strict inward dependency flow (`domain → application → adapters → presentation`),
- side effects pushed to the boundary via port / adapter separation,
- structured, layer-tagged error serialization across the stack.

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Interactive by default** — Server functions are only the transport; `useActionState` / `useTransition` / `useOptimistic` sit on top for instant feedback. The `/todo` route is the worked example (optimistic toggle, optimistic inline edit, optimistic list add/remove). Skipping this layer is what produces a round-trip-only, sluggish UI.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Drizzle ORM + SQLite dialect** — Schema, migrations, and repositories share a single Drizzle definition. Adapter classes translate driver-specific errors into the shared error contracts.
- **Outbox pattern** — Domain events are persisted in the same transaction as aggregate writes, then a relay publishes them to consumers. At-least-once delivery, no ordering guarantees, idempotency is the subscriber's responsibility.
- **TypeScript / Biome / Vitest / fast-check** — Type checking with `tsgo`, lint and format via Biome, two-tier Vitest setup (unit / integration).
- **Structured error serialization** — Each layer carries its own `kind`-tagged serialized form; presentation composes the union structurally. HTTP status mapping lives only in presentation.

## Directory layout

```
packages/
└─ core/              # @repo/core — framework-free, imported as @repo/core/*
   └─ src/
      ├─ domain/      # entities, value objects, port interfaces, domain events
      ├─ application/ # use cases, UoW, cross-cutting ports (clock / id / logger), DTO projection
      ├─ adapters/    # concrete port implementations (DB, workers, external services)
      └─ lib/         # structural primitives shared by every layer (e.g. CodedError)
apps/
└─ web/               # @repo/web — the TanStack Start app + its runtime configs
   ├─ app/
   │  ├─ presentation/ # server-function entry, error responses, input validation
   │  ├─ routes/       # TanStack Router (file-based)
   │  ├─ components/
   │  ├─ styles/
   │  ├─ worker/       # background-worker entries (relay / consumer / pruner / dlq)
   │  └─ server.cloudflare.ts  # server fetch entry
   └─ scripts/         # render-wrangler.ts (renders wrangler.<stage>.toml from its .tpl)
infra/                # cloudflare (Pulumi)
docs/                 # implementation pattern examples + the Cloudflare runtime guide + the testing guide
spec/                 # entry point for the /spec workflow
```

For the deeper rationale, see [`CLAUDE.md`](CLAUDE.md), [`docs/backend_implementation_example.md`](docs/backend_implementation_example.md), and [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md).

## Reference runtime

The template targets **Cloudflare Workers + D1 + Queues** — multi-worker, edge-distributed, managed queues. The main app runs in the top-level Worker; outbox publish, queue consumption, daily pruning, and DLQ surfacing each ship as a sibling Worker.

To target a different runtime (Bun, Fly Machines, etc.), add a new adapter group under `packages/core/src/adapters/{provider}/` and a paired entry point — the inward layers stay put.

Operational guidance: [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## Requirements

- Node.js (the `flake.nix` / `.envrc` direnv environment is recommended)
- pnpm
- A Cloudflare account and the `wrangler` CLI (bundled as a dev dependency) for deployment

## Quick Start

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # wrangler-loaded secrets for local dev (gitignored)
openssl rand -base64 48    # paste into SESSION_SECRET (ships empty)
pnpm db:migrate            # apply SQL migrations to the local D1
pnpm dev                   # vite dev server backed by workerd on http://localhost:3000
```

For a production build:

```bash
pnpm build
```

The build output cannot be run locally yet — both `pnpm start` (`wrangler dev`) and `pnpm preview` fail to boot ([#40](https://github.com/tuanemuy/fog/issues/40)); see [Development commands](#development-commands) for the cause. Use `pnpm dev`, or deploy to a stage.

See [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md) for deployment, secrets, queues, and per-stage D1 management.

## Development commands

```bash
pnpm dev                         # alias of pnpm dev:cf
pnpm dev:cf                      # vite dev (Cloudflare / workerd)

pnpm build                       # alias of pnpm build:cf
pnpm build:cf

pnpm start                       # alias of pnpm start:cf
pnpm start:cf                    # wrangler dev (top-level Worker) — currently fails to boot, see below
pnpm preview                     # vite preview (serves the build output) — fails to boot for the same reason

pnpm typecheck                   # tsgo (@typescript/native-preview)
pnpm lint                        # Biome lint
pnpm lint:fix                    # Biome check --write
pnpm format                      # Biome format --write
pnpm format:check

pnpm test                        # unit + integration
pnpm test:unit                   # Vitest (unit)
pnpm test:integration            # integration suites
```

**`pnpm start` does not work today** ([#40](https://github.com/tuanemuy/fog/issues/40)). `wrangler dev` bundles the Worker successfully, but workerd refuses to start it: `packages/core/src/application/workers/eventRelayWorker.ts` calls `crypto.randomUUID()` at module scope, and workerd disallows generating random values outside a handler. The top-level Worker reaches that module through `server.cloudflare.ts → application/di/serverCloudflare.ts → application/di/env.ts → application/workers/eventRelayWorker.ts` (`env.ts` value-imports the `DEFAULT_*` tuning constants from it). `pnpm preview` fails identically for the same reason, so **`pnpm dev` is the only way to run the app locally** — Vite evaluates modules inside the request handler, where the restriction does not apply. `pnpm build` itself is unaffected.

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Database migrations

Migration SQL is generated from `schema.ts` and committed.

```bash
pnpm db:generate                       # alias of db:generate:cf
pnpm db:generate:cf                    # generate D1 SQL
pnpm db:migrate                        # alias of db:migrate:cf
pnpm db:migrate:cf                     # wrangler d1 migrations apply (local D1)
```

For per-stage D1 migration management, see [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## License

Undecided (private).
