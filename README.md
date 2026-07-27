# fog

Fog is a personal knowledge application built with TanStack Start, React 19,
Cloudflare Workers, and SQLite-backed Durable Objects.

## Architecture

- `packages/core` contains framework-free domain/application code and
  Cloudflare adapters.
- `apps/web` contains the TanStack Start UI and two Worker entries:
  the public request Worker and the private state Worker.
- The state Worker exports three independent SQLite Durable Object classes:
  `UserDataDurableObject`, `IdentityDirectoryDurableObject`, and
  `AccountHomeDurableObject`.
- User content and its FTS5 projection commit in one Durable Object SQLite
  transaction. External I/O and retention work use persistent Alarm jobs.
- `infra/cloudflare/pulumi` manages DNS and custom-domain binding only.

See [CLAUDE.md](CLAUDE.md) for code conventions and
[docs/runtime_cloudflare.md](docs/runtime_cloudflare.md) for the deployment and
operations runbook.

## Requirements

- Node.js 22.12 or later
- pnpm 11.1.2
- A Cloudflare account and authenticated Wrangler CLI for remote operations

## Local development

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
openssl rand -base64 48
openssl rand -base64 48
pnpm dev
```

Paste one generated secret into each active field before starting. `pnpm dev`
generates binding types, builds the request Worker through Vite, and starts the
request config first and state config second in one Wrangler multi-config
session. The request Worker is available at `http://localhost:8787`; both
Workers share `apps/web/.wrangler/state` for local persistence.

## Commands

```bash
pnpm dev                # request + state Workers
pnpm build              # request Vite build + state Worker dry build
pnpm start              # run the built topology locally with Wrangler
pnpm cf:types           # generate cross-Worker binding types
pnpm test               # unit + workerd integration tests
pnpm typecheck
pnpm lint
pnpm format:check

pnpm cf:render:staging
pnpm deploy:staging:dry
pnpm deploy:staging     # state first, request second
```

Use the corresponding `production` commands for production. A real deployment
is not part of local verification.
