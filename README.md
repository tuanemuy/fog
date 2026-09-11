# fog

A personal knowledge tool: post memos to a timeline, distil them into documents under topics, search everything, and let an AI client work on the same data through OAuth 2.1 + MCP / REST. Built on **TanStack Start + React 19 (RSC)** with a **DDD / Hexagonal architecture** on Cloudflare Workers and per-user SQLite-backed Durable Objects. The requirements, scenarios, screens, domain model, usecases and test cases live in [`spec/`](spec/index.md). The Worker and package names still read `tanstack-start-template`, the template this repository started from.

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Interactive by default** — Server functions are only the transport; `useActionState` / `useTransition` / `useOptimistic` sit on top for instant feedback. `apps/web/app/components/auth/AuthForm` (`useActionState`, one form for login and signup) and `apps/web/app/components/settings/LogoutButton` (`useTransition`) are the small references; `timeline/TimelineBoard`, `topics/TopicList` and `trash/TrashBoard` are the optimistic list owners the pattern in [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md) describes.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Raw SQL inside the Durable Object** — every store issues `sql.exec` statements against the DO's SQLite; there is no ORM. Adapters translate driver-specific errors into the shared error contracts.
- **Outbox pattern** — Domain events are persisted in the same transaction as aggregate writes, then a relay inside the DO's `alarm()` publishes them to a Queue. At-least-once delivery, no ordering guarantees, idempotency is the subscriber's responsibility.
- **TypeScript / Biome / Vitest** — Type checking with `tsgo`, lint and format via Biome, three Vitest projects (unit, jsdom DOM, Durable Object integration in a Workers isolate) — see [`docs/test.md`](docs/test.md).
- **Structured error serialization** — Each layer carries its own `kind`-tagged serialized form; presentation composes the union structurally. HTTP status mapping lives only in presentation.

## Directory layout

```
packages/
└─ core/              # @repo/core — framework-free, imported as @repo/core/*
   └─ src/
      ├─ domain/      # entities, value objects, port interfaces, domain events
      ├─ application/ # use cases, UoW, cross-cutting ports (clock / id / logger), DTO projection
      ├─ adapters/    # concrete port implementations (Durable Objects, mail, SSO, WebCrypto, zip)
      └─ lib/         # structural primitives shared by every layer (e.g. CodedError)
apps/
└─ web/               # @repo/web — the TanStack Start app + its runtime configs
   ├─ app/
   │  ├─ presentation/ # server-function entry, error responses, input validation, session, AI API, export
   │  ├─ routes/       # TanStack Router (file-based)
   │  ├─ components/
   │  ├─ styles/
   │  ├─ worker/       # state Worker entry (owns the DO classes), the request Worker's queue handlers,
   │  │                # the /__operator maintenance surface, the SSO callback, /__diagnostics
   │  └─ server.cloudflare.ts  # server fetch entry
   └─ scripts/         # render-wrangler.ts, operator.ts, ai-client.ts (see Development commands)
infra/                # cloudflare (Pulumi)
docs/                 # implementation pattern examples + the Cloudflare runtime guide + the testing guide
spec/                 # requirements, scenarios, pages, domains, usecases, database, async, rotation,
                      # recovery, test cases and manual tests — the authority the code implements
```

For the deeper rationale, see [`CLAUDE.md`](CLAUDE.md), [`docs/backend_implementation_example.md`](docs/backend_implementation_example.md), and [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md).

## Reference runtime

The app targets **Cloudflare Workers + per-user SQLite-backed Durable Objects + Queues**. Two Workers ship: a **request Worker** that serves HTTP, does the CPU-bound work, and hosts the queue consumers and the DLQ handler in its `queue()` handler, and a **state Worker** that owns the Durable Object classes. Outbox rows live in the Durable Object that emitted them, and the relay runs inside that DO's `alarm()` — it has no Worker of its own. Every piece of user data lives in that user's Durable Object; credentials live in bucketed Identity Directory Durable Objects. The application binds no D1 database.

To target a different runtime (Bun, Fly Machines, etc.), add a new adapter group under `packages/core/src/adapters/{provider}/` and a paired entry point — and budget for revisiting the synchronous port contracts, as `CLAUDE.md` explains.

Operational guidance — deployment, secrets, schema migration, the Alarm, the operator surface, key rotation, PITR and the tuning values — is in [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md). The per-stage checklist also lives in the header of `apps/web/wrangler.<stage>.toml.tpl`, and the secret-ownership table in [`apps/web/.dev.vars.example`](apps/web/.dev.vars.example).

## Requirements

- Node.js 22.12+ (the `flake.nix` / `.envrc` direnv environment is recommended; the scripts under `apps/web/scripts/` run on Node's type stripping without a build step)
- pnpm
- A Cloudflare account and the `wrangler` CLI (bundled as a dev dependency) for deployment

## Quick Start

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # wrangler-loaded secrets for local dev (gitignored)
pnpm dev                   # vite dev server backed by workerd on http://localhost:3000
```

Six secrets ship empty in the template and must be filled before the first `pnpm dev`, each with `openssl rand -base64 48` (at least 32 characters): `SESSION_SECRET`, `DIRECTORY_ROUTING_SECRET`, `IDENTITY_MAIL_ENCRYPTION_KEY`, `PROVIDER_IDEMPOTENCY_KEY`, `IDENTITY_RESET_TOKEN_KEY` and `AI_CLIENT_TOKEN_SECRET`. The template's `MAIL_DEV_SINK="console"` prints reset mails to the dev log as `[dev-mail]` lines and `SSO_DEV_STUB="true"` serves a development identity provider at `/__dev/sso/<provider>/authorize`, so registration, login, password reset and SSO all work with no external account. `OPERATOR_TOKEN` is needed only to use the `/__operator/*` surface. Which Worker owns which variable is the table at the top of `.dev.vars.example`.

Sign-up, login and every read go to Durable Objects, whose schema is applied lazily on first use with no command to run.

For a production build:

```bash
pnpm build
```

`pnpm preview` runs that output locally on workerd: the top page responds, and `/__diagnostics/schema-version` makes one round trip from the request Worker into a Durable Object, which is what proves the cross-Worker binding is actually wired. `pnpm start` (`wrangler dev`) is the one local path that does not boot — see [Development commands](#development-commands) for the cause.

**`APP_URL` is pinned to `http://localhost:3000` in `wrangler.toml`**, while `vite preview` picks its own port. Under `pnpm preview` the address in the browser bar therefore disagrees with `og:url`, the canonical link and the links inside `[dev-mail]` output. That is expected, not a misconfiguration. `pnpm dev` and `pnpm preview` share `apps/web/.wrangler/state`, so run one at a time: two workerd instances over the same Durable Object files take each other's Alarms.

To deploy: render the configs, install each secret against the config of the Worker that owns it, set the DLQ retention out of band, then deploy the **state Worker first** and the request Worker second. The full procedure is in [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md); the same checklist is summarised in the header of `apps/web/wrangler.<stage>.toml.tpl`, and which secret belongs to which Worker is declared in [`apps/web/.dev.vars.example`](apps/web/.dev.vars.example).

**The request Worker cannot be deployed today** — the same unresolved TanStack Start virtual modules that keep `pnpm start` from booting also break `wrangler deploy`.

## Development commands

```bash
pnpm dev                         # alias of pnpm dev:cf
pnpm dev:cf                      # vite dev (Cloudflare / workerd)

pnpm build                       # alias of pnpm build:cf
pnpm build:cf

pnpm start                       # alias of pnpm start:cf
pnpm start:cf                    # wrangler dev (both Workers) — fails to boot, see below
pnpm preview                     # vite preview (serves the build output)

pnpm typecheck                   # tsgo (@typescript/native-preview)
pnpm lint                        # Biome lint
pnpm lint:fix                    # Biome check --write
pnpm format                      # Biome format --write
pnpm format:check

pnpm test                        # unit + DOM + integration
pnpm test:unit                   # Vitest (unit + DOM projects)
pnpm test:integration            # Durable Object suites in a Workers isolate

pnpm --filter @repo/web operator <entry> --locator <dir:gN:bM | userId> [--json '{…}'] [--inject-keyring] [--limit N] [--after id] [--base http://localhost:3000]
pnpm --filter @repo/web ai-client -- register|authorize|refresh|whoami|mcp <method> ['<json>']|call <tool> ['<json>']
```

**`pnpm start` does not boot, and the request Worker cannot be deployed — one cause.** Re-checked at HEAD `f14fcd8` (2026-09-11): `pnpm start:cf` loads both configs, lists both Workers' bindings, then fails while bundling the request Worker with `Build failed with 5 errors: Could not resolve "#tanstack-router-entry" / "#tanstack-start-entry" / "#tanstack-start-plugin-adapters" / "tanstack-start-manifest:v" / "tanstack-start-injected-head-scripts:v"` — virtual modules only the Vite plugin supplies. The state Worker alone (`wrangler dev -c wrangler.state.toml`) starts fine; `pnpm deploy:<stage>` fails at the same point because all deploy templates point `main` at that source entry, so `pnpm deploy:<stage>:all` lands only its state half. `pnpm dev`, `pnpm preview` and `pnpm build` go through Vite and are unaffected.

### The operator surface

`POST /__operator/<entry>` is the maintenance surface of `spec/database/index.md` — the poisoned-job and quarantined-event listings and re-drives, `purge-user-mappings`, `list-bucket-user-ids`, `read-schema-version`, `read-delivery-backlog`, and the key-rotation entries (`remap-chunk`, `import-remapped-mappings`, `record-remapped-locator`, `read-rotation-checkpoint`, `start-rotate-encryption`). It exists only while `OPERATOR_TOKEN` is set (404 otherwise), takes the token as a bearer, and logs `entry` / `locator` / `outcome` and never a body. `apps/web/scripts/operator.ts` is the CLI over it: it reads `OPERATOR_TOKEN` (and, with `--inject-keyring`, the routing keyring) from `apps/web/.dev.vars` so no key is typed on a command line. The rotation procedure is in `docs/runtime_cloudflare.md`.

### The AI client

`apps/web/scripts/ai-client.ts` is a test client for the AI API: `register` performs dynamic client registration, `authorize` prints the consent URL (open it in a logged-in browser; the redirect lands on a loopback server the script starts), then `call <tool>` / `mcp <method>` exercise the REST and MCP endpoints with the issued token. State lives in `apps/web/.ai-client.json` (gitignored). The AI scope has no hard delete, no trash and no history by construction.

### Export

The settings screen's データ section posts to `POST /export` and saves a Markdown zip (`fog-export-<date>.zip`: `index.md`, `memos/<day>.md`, `topics/<topic>/…`) — completed topics included, trash and history excluded, 24 MiB of source text at most. Non-ASCII file names carry the UTF-8 flag; macOS's bundled `unzip` cannot extract them, `ditto -x -k` or Python's `zipfile` can.

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Database migrations

### Durable Objects — lazy, no command

Each DO carries a `schema_version` and applies the steps it is missing on its first RPC of a wake-up, inside the same transaction that advances the version; data rewrites and FTS5 rebuilds that a step needs run afterwards as the `migrate-bulk` / `reindex` jobs under a `migration_progress` cursor. **There is nothing to run, locally or in production.** Schema is forward-only: a release that advances the version cannot be rolled back, because a DO ahead of the code fails closed. The procedure, the fail-closed behaviour and how to discard local DO state are in [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## Out of scope

Implemented as contract-verified only, with development stand-ins: a real SSO identity provider (Google's adapter exists and needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; there is no Apple adapter, the dev stub covers both), a real mail provider (`MAIL_PROVIDER_API_KEY`), and a real LLM application on the AI API (the test client stands in). Not implemented: a user-facing withdrawal usecase (the withdrawal job runs only from the registration saga's abandon path) and a production deployment.

## License

Undecided (private).
