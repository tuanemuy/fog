# tanstack-start-template

A reference template for building applications with **TanStack Start + React 19 (RSC)** on a **DDD / Hexagonal architecture** foundation.

The goal is to give you a worked example of:

- file-based routing and server components as the default data-fetching path,
- a strict inward dependency flow (`domain → application → adapters → presentation`),
- side effects pushed to the boundary via port / adapter separation,
- structured, layer-tagged error serialization across the stack.

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Interactive by default** — Server functions are only the transport; `useActionState` / `useTransition` / `useOptimistic` sit on top for instant feedback. The shipped references are `apps/web/app/components/auth/{LoginForm,SignupForm}` (`useActionState`) and `apps/web/app/components/settings/LogoutButton` (`useTransition`); the optimistic list patterns are worked through in [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md). Skipping this layer is what produces a round-trip-only, sluggish UI.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Raw SQL inside the Durable Object** — every store issues `sql.exec` statements against the DO's SQLite; there is no ORM. Adapters translate driver-specific errors into the shared error contracts.
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
   │  ├─ worker/       # state Worker entry (owns the DO classes) + the request Worker's queue handlers
   │  └─ server.cloudflare.ts  # server fetch entry
   └─ scripts/         # render-wrangler.ts (renders both Workers' <stage> configs from their .tpl)
infra/                # cloudflare (Pulumi)
docs/                 # implementation pattern examples + the Cloudflare runtime guide + the testing guide
spec/                 # entry point for the /spec workflow
```

For the deeper rationale, see [`CLAUDE.md`](CLAUDE.md), [`docs/backend_implementation_example.md`](docs/backend_implementation_example.md), and [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md).

## Reference runtime

The template targets **Cloudflare Workers + per-user SQLite-backed Durable Objects + Queues**. Two Workers ship: a **request Worker** that serves HTTP, does the CPU-bound work, and hosts the queue consumers and the DLQ handler in its `queue()` handler, and a **state Worker** that owns the Durable Object classes. Outbox rows live in the Durable Object that emitted them, and the relay runs inside that DO's `alarm()` — it has no Worker of its own. Every piece of user data lives in that user's Durable Object. The application no longer binds D1; the D1 resource in `infra/cloudflare/pulumi` is left as is and is not read by anything ([#79](https://github.com/tuanemuy/fog/issues/79)).

To target a different runtime (Bun, Fly Machines, etc.), add a new adapter group under `packages/core/src/adapters/{provider}/` and a paired entry point — the inward layers stay put.

Operational guidance — deployment, secrets, schema migration, the Alarm, the operator paths, PITR and the production tuning values — is in [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md). The per-stage checklist also lives in the header of `apps/web/wrangler.<stage>.toml.tpl`, and the secret-ownership table in [`apps/web/.dev.vars.example`](apps/web/.dev.vars.example).

## Requirements

- Node.js (the `flake.nix` / `.envrc` direnv environment is recommended)
- pnpm
- A Cloudflare account and the `wrangler` CLI (bundled as a dev dependency) for deployment

## Quick Start

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # wrangler-loaded secrets for local dev (gitignored)
openssl rand -base64 48    # paste into SESSION_SECRET (ships empty)
pnpm dev                   # vite dev server backed by workerd on http://localhost:3000
```

Sign-up, login and every read go to Durable Objects, whose schema is applied lazily on first use with no command to run.

For a production build:

```bash
pnpm build
```

`pnpm preview` runs that output locally on workerd: the top page responds, and `/__diagnostics/schema-version` makes one round trip from the request Worker into a Durable Object, which is what proves the cross-Worker binding is actually wired. `pnpm start` (`wrangler dev`) is the one local path that does not boot — see [Development commands](#development-commands) for the cause.

**`APP_URL` is pinned to `http://localhost:3000` in `wrangler.toml`**, while `vite preview` picks its own port. Under `pnpm preview` the address in the browser bar therefore disagrees with `og:url` and the canonical link. That is expected, not a misconfiguration.

To deploy: render the configs, install each secret against the config of the Worker that owns it, set the DLQ retention out of band, then deploy the **state Worker first** and the request Worker second. The full procedure — including what can be run today and what cannot — is in [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md); the same checklist is summarised in the header of `apps/web/wrangler.<stage>.toml.tpl`, and which secret belongs to which Worker is declared in [`apps/web/.dev.vars.example`](apps/web/.dev.vars.example).

**The request Worker cannot be deployed today** — the same unresolved TanStack Start virtual modules that keep `pnpm start` from booting also break `wrangler deploy`. Tracking: [#73](https://github.com/tuanemuy/fog/issues/73).

## Development commands

```bash
pnpm dev                         # alias of pnpm dev:cf
pnpm dev:cf                      # vite dev (Cloudflare / workerd)

pnpm build                       # alias of pnpm build:cf
pnpm build:cf

pnpm start                       # alias of pnpm start:cf
pnpm start:cf                    # wrangler dev (both Workers) — currently fails to boot, see below
pnpm preview                     # vite preview (serves the build output)

pnpm typecheck                   # tsgo (@typescript/native-preview)
pnpm lint                        # Biome lint
pnpm lint:fix                    # Biome check --write
pnpm format                      # Biome format --write
pnpm format:check

pnpm test                        # unit + integration
pnpm test:unit                   # Vitest (unit)
pnpm test:integration            # integration suites
```

**`pnpm start` does not boot, and the request Worker cannot be deployed — one cause, tracked as [#73](https://github.com/tuanemuy/fog/issues/73).** `wrangler` cannot resolve the TanStack Start virtual modules `#tanstack-start-entry`, `#tanstack-router-entry` and `tanstack-start-manifest:v`, which only the Vite plugin supplies. So:

- `pnpm start` (`wrangler dev -c wrangler.toml -c wrangler.state.toml`) loads both configs and recognises both Workers' bindings, then fails while bundling the request Worker. The single-config `wrangler dev -c wrangler.toml` fails on the same three, and the state Worker alone (`wrangler dev -c wrangler.state.toml`) starts fine — this is about running `wrangler` against the source entry, not about the two-Worker layout.
- `pnpm deploy:<stage>` fails at the same point, because all four deploy templates point `main` at that source entry. `pnpm deploy:<stage>:state` works, so `pnpm deploy:<stage>:all` lands only its first half.

`pnpm dev`, `pnpm preview` and `pnpm build` all go through Vite and are unaffected.

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Database migrations

### Durable Objects — lazy, no command

Each DO carries a `schema_version` and applies the steps it is missing on its first RPC of a wake-up, inside the same transaction that advances the version. **There is nothing to run, locally or in production.** Schema is forward-only: a release that advances the version cannot be rolled back, because a DO ahead of the code fails closed. The procedure, the fail-closed behaviour and how to discard local DO state are in [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

### D1

The application binds no D1 database. The `${prefix}-d1` resource in `infra/cloudflare/pulumi/resources` is intentionally left untouched ([#79](https://github.com/tuanemuy/fog/issues/79)); nothing reads it.

## License

Undecided (private).
