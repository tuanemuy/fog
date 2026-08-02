# fog

A reference application built with **TanStack Start + React 19 (RSC)** on a **DDD / Hexagonal architecture** foundation, storing every user's data in its own SQLite-backed Durable Object.

The goal is to give you a worked example of:

- file-based routing and server components as the default data-fetching path,
- a strict inward dependency flow (`domain → application → adapters → presentation`),
- side effects pushed to the boundary via port / adapter separation,
- structured, layer-tagged error serialization across the stack.

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Interactive by default** — Server functions are only the transport; `useActionState` / `useTransition` / `useOptimistic` sit on top for instant feedback. `components/auth/{LoginForm,SignupForm}` and `components/settings/LogoutButton` are the shipped references. Skipping this layer is what produces a round-trip-only, sluggish UI.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Per-user Durable Objects** — One SQLite-backed Durable Object per user holds that user's data; credentials live in bucketed Identity Directory DOs keyed by an HMAC of the canonical address. Tenant isolation is structural: there is no tenant predicate to forget, because no code path can obtain another user's stub.
- **Synchronous transactions** — Every transactional use case runs inside `UnitOfWorkProvider.run(fn)`, whose signature type-rejects `async` callbacks. Optimistic concurrency is a conditional `UPDATE … RETURNING 1`; a zero-row match surfaces as `ConflictError` rather than being retried under the covers.
- **Alarm-driven jobs** — Work that cannot finish inside a transaction rides a durable `jobs` row and each DO's Alarm: mail, expiry sweeps, checkpointed bulk work, cross-DO saga advancement. At-least-once, no ordering guarantee between kinds, retry owned by the job runner.
- **Full-text search in the same transaction** — An FTS5 index lives beside the data it indexes and is maintained in the same `transactionSync`, so there is no projection lag and no separate search service.
- **TypeScript / Biome / Vitest** — Type checking with `tsgo`, lint and format via Biome, three Vitest suites (unit / integration / boot smoke).
- **Structured error serialization** — Each layer carries its own `kind`-tagged serialized form; presentation composes the union structurally. HTTP status mapping lives only in presentation.

## Directory layout

```
packages/
└─ core/              # @repo/core — framework-free, imported as @repo/core/*
   └─ src/
      ├─ domain/      # entities, value objects, port interfaces
      ├─ application/ # use cases, UoW, cross-cutting ports (clock / id / logger), DTO projection
      ├─ adapters/    # concrete port implementations (Durable Object storage, WebCrypto, …)
      └─ lib/         # structural primitives shared by every layer (e.g. CodedError)
apps/
└─ web/               # @repo/web — the TanStack Start app + its runtime configs
   ├─ app/
   │  ├─ presentation/     # server-function entry, error responses, input validation
   │  ├─ routes/           # TanStack Router (file-based)
   │  ├─ components/
   │  ├─ styles/
   │  ├─ durable-objects/  # UserDataDurableObject / IdentityDirectoryDurableObject
   │  ├─ worker/cloudflare/state.ts  # state Worker entry (exports the DO classes)
   │  └─ server.cloudflare.ts        # request Worker fetch entry
   └─ scripts/         # render-wrangler.ts (renders the four wrangler.<role>.<stage>.toml from their .tpl)
infra/                # cloudflare (Pulumi)
docs/                 # implementation pattern examples + the Cloudflare runtime guide + the testing guide
spec/                 # entry point for the /spec workflow
```

For the deeper rationale, see [`CLAUDE.md`](CLAUDE.md), [`docs/backend_implementation_example.md`](docs/backend_implementation_example.md), and [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md).

## Reference runtime

The app targets **Cloudflare Workers with per-user SQLite-backed Durable Objects**, and deploys as **two Workers**:

- **request Worker** (`fog`) — serves HTTP and does the CPU-bound work: password hashing, token signing, canonical-address HMAC routing, export rendering.
- **state Worker** (`fog-state`) — owns the two Durable Object classes and nothing else. It has no public routes; the request Worker reaches it through bindings.

Each Worker has its own wrangler config, and the two secret sets do not overlap — see [`apps/web/.dev.vars.example`](apps/web/.dev.vars.example) for which secret belongs to which side and why.

To target a different runtime (Bun, Fly Machines, etc.), add a new adapter group under `packages/core/src/adapters/{provider}/` and a paired entry point — but budget for revisiting the port contracts too, since the domain's repository ports are synchronous.

Operational guidance: [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## Requirements

- Node.js (the `flake.nix` / `.envrc` direnv environment is recommended)
- pnpm
- A Cloudflare account and the `wrangler` CLI (bundled as a dev dependency) for deployment

## Quick Start

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # wrangler-loaded secrets for local dev (gitignored)
openssl rand -base64 48    # generate a value for each entry — all five ship empty
pnpm dev                   # vite dev server backed by workerd on http://localhost:3000
```

`pnpm dev` boots both Workers: the state Worker runs as an auxiliary worker of the same vite server, so Durable Object calls resolve without a second terminal. Storage is persisted under `apps/web/.wrangler/state`; delete that directory to start from an empty database.

There is no migration step to run. Each Durable Object creates its own schema on first touch and advances it through the lazy migration gate.

For a production build:

```bash
pnpm build
```

`pnpm start` (`wrangler dev` against the build output) and `pnpm preview` (`vite preview`) both serve that build; each runs the request Worker alone, so run `pnpm dev:state` alongside them for flows that reach a Durable Object.

See [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md) for deployment and secrets.

## Development commands

```bash
pnpm dev                         # alias of pnpm dev:cf
pnpm dev:cf                      # vite dev (request Worker + state Worker on workerd)
pnpm dev:state                   # state Worker on its own (wrangler dev -c wrangler.state.toml)

pnpm build                       # alias of pnpm build:cf
pnpm build:cf                    # two stages: dist/server (+ dist/client), then dist/state

pnpm start                       # alias of pnpm start:cf
pnpm start:cf                    # wrangler dev against the build output
pnpm preview                     # vite preview (serves the build output)

pnpm typecheck                   # tsgo (@typescript/native-preview)
pnpm lint                        # Biome lint
pnpm lint:fix                    # Biome check --write
pnpm format                      # Biome format --write
pnpm format:check

pnpm test                        # unit + integration
pnpm test:unit                   # Vitest, Node pool
pnpm test:integration            # Vitest, Workers pool, against real DO SQLite
pnpm test:smoke                  # boots the build output under workerd (run pnpm build:cf first)
```

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Deployment

Each stage deploys two Workers, and **the state Worker goes first**: the request Worker's Durable Object bindings name its script, which must already exist.

```bash
pnpm cf:render:staging           # render the two wrangler.<role>.staging.toml from their .tpl
pnpm deploy:staging              # state, then request
pnpm deploy:staging:dry          # same order, --dry-run
pnpm deploy:state:staging        # one role at a time, when you need it
pnpm deploy:request:staging
```

`production` has the same five. Every script also exists on `@repo/web`, so `pnpm --filter @repo/web deploy:state:staging` works from anywhere in the repo.

The `deploy:*` scripts changed shape when the app split into two Workers:

| Before | Now |
|---|---|
| `deploy:{stage}` / `:dry` | `deploy:request:{stage}` / `:dry` |
| `deploy:{stage}:relay` / `:consumer` / `:pruner` / `:dlq` (+ `:dry`) | gone — those Workers no longer exist |
| `deploy:{stage}:all` / `:all:dry` | `deploy:{stage}` / `:dry` (state, then request) |
| — | `deploy:state:{stage}` / `:dry` (new) |

Durable Object namespaces are **not** provisioned by Pulumi. The state Worker's config declares its classes through `exports`, and the deploy creates the namespaces. Note that this is a one-way door: a class deployed through `exports` cannot be moved back to a `[[migrations]]` entry.

## License

Undecided (private).
