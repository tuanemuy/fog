# Runtime: Cloudflare Workers (D1 + Queues)

> [!WARNING]
> **本書は D1 + Queues 時代の運用手順であり、現行の構成を反映していない。** #37 が撤去した機構 — D1 / Queues / relay・consumer・pruner・dlq の4 Worker / named environment（`--env <role>`）/ `db:*` スクリプト10本 / `OUTBOX_*` 変数 / `wrangler.<stage>.toml` — を前提に書かれている。ここに載っているコマンドの多くは**もう存在しない**。現行は request / state の2 Worker 構成で、永続化はユーザーごとの SQLite-backed Durable Object、非同期処理は `jobs` テーブルと Alarm、マイグレーションは DO 内の lazy gate（適用コマンド無し）である。**書き換えは [#38](https://github.com/tuanemuy/fog/issues/38) が担当する。** それまでの正本は `README.md`「Deployment」（デプロイ手順とスクリプト対応表）と `apps/web/.dev.vars.example`（秘密の配布境界）、そして `CLAUDE.md`「Reference runtime」である。

Multi-Worker, edge-distributed runtime. The main app runs in the `app` Worker; outbox publish, queue consumption, daily pruning, and DLQ surfacing each ship as a sibling Worker driven by Service Bindings, Queues, and Cron Triggers.

## Table of contents

- [Quick start](#quick-start)
- [Worker matrix](#worker-matrix)
- [Wrangler config layout](#wrangler-config-layout)
- [One-time Cloudflare resource creation](#one-time-cloudflare-resource-creation)
- [Secrets and vars](#secrets-and-vars)
- [Session secret rotation](#session-secret-rotation)
- [Deployment](#deployment)
- [D1 migrations](#d1-migrations)
- [Queues](#queues)
- [Cron triggers](#cron-triggers)
- [Retry budget](#retry-budget)

## Quick start

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # wrangler-loaded secrets for local dev (gitignored)
openssl rand -base64 48                # paste into SESSION_SECRET (ships empty)
pnpm db:migrate:cf                     # apply migrations to the local D1
pnpm dev:cf                            # vite dev backed by workerd (@cloudflare/vite-plugin)
```

`SESSION_SECRET` is the one value with no usable default: a key printed in the repository is a key everyone has, so the example ships it empty and every request fails until it is set.

`apps/web/.dev.vars` is auto-loaded by `wrangler dev` (and the workerd-backed `pnpm dev:cf`) and mirrors `wrangler secret put` for production. Non-secret config such as `APP_URL` belongs in the matching `apps/web/wrangler*.toml` `[vars]`, not in `.dev.vars`.

## Worker matrix

The main app and four sibling Workers ship from a **per-stage `wrangler.<stage>.toml`** as named environments. Each is deployed independently with `wrangler deploy --config wrangler.<stage>.toml --env <role>`, exposed as `pnpm deploy:<stage>:<role>` scripts.

| Worker      | Responsibility                                                | Wrangler env     | Trigger                                              |
| ----------- | ------------------------------------------------------------- | ---------------- | ---------------------------------------------------- |
| App (fetch) | TanStack Start HTTP request handling                          | _(top level)_    | HTTP                                                 |
| Relay       | Publish outbox rows — Service Binding kick + safety-net cron  | `--env relay`    | `fetch` (Service Binding) + 5-minute Cron Trigger    |
| Consumer    | Consume the Queue (projections / notifications)               | `--env consumer` | Queue consumer (`events`)                            |
| Pruner      | Daily cron that prunes processed outbox rows                  | `--env pruner`   | Daily Cron Trigger                                   |
| DLQ         | Surface events that exhausted the consumer's retry budget     | `--env dlq`      | Queue consumer (`events-dlq`)                        |

Trigger model: the request path kicks the relay through the `RELAY` Service Binding right after a UoW commit, so newly-persisted events publish without waiting on cron. The relay also runs on a 5-minute safety-net cron in case the Service Binding path fails. Inside a tick, `processOutboxEvents` drains up to `maxIterations` consecutive batches so a backlog is flushed in one trigger rather than 1 batch per minute.

## Wrangler config layout

| File                       | Purpose                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/wrangler.toml`            | **Local dev only** — `pnpm dev:cf` / `pnpm build:cf` discover it via `@cloudflare/vite-plugin`. Do not deploy from this file. |
| `apps/web/wrangler.staging.toml`    | Generated staging config (`pnpm cf:render:staging`).                                                    |
| `apps/web/wrangler.production.toml` | Generated production config (`pnpm cf:render:production`).                                              |

Each stage file is a self-contained mirror of `wrangler.toml` with `-staging` / `-production` suffixed on every Cloudflare resource name (Worker name, D1 `database_name`, queue names) so the two stages never collide inside one Cloudflare account.

**Wrangler env caveat**: top-level `d1_databases` / `vars` are **not** inherited into named environments. Each `[env.*]` block re-declares them — keep `database_id`, queue names, and `APP_URL` in sync across every block of every stage config. `pnpm cf:types` (re)generates `worker-configuration.d.ts` from `wrangler.toml` only; this also runs automatically on `postinstall` and `predev:cf`.

## One-time Cloudflare resource creation

Cloudflare Queues and D1 databases are provisioned by the `@repo/infra-cloudflare` Pulumi package. Update the matching `infra/cloudflare/pulumi/resources/Pulumi.<stage>.yaml`, authenticate the Pulumi and Cloudflare CLIs, then create the persistent resources:

```bash
pnpm --filter @repo/infra-cloudflare exec pulumi -C resources -s staging up
pnpm --filter @repo/infra-cloudflare exec pulumi -C resources -s production up
```

Render the ignored, stage-specific Wrangler configs from those Pulumi outputs:

```bash
pnpm cf:render:staging
pnpm cf:render:production
```

Rerun the matching render command whenever a persistent-resource output or public URL changes.

## Secrets and vars

Secrets are scoped per `--config` (and per `--env` for sibling Workers), so set them per stage:

```bash
pnpm --filter @repo/web exec wrangler secret put MY_SECRET --config wrangler.staging.toml
pnpm --filter @repo/web exec wrangler secret put MY_SECRET --config wrangler.staging.toml --env relay
pnpm --filter @repo/web exec wrangler secret put MY_SECRET --config wrangler.production.toml
```

For local dev, drop them into `apps/web/.dev.vars` (copied from `apps/web/.dev.vars.example`).

The outbox tuning variables (`OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_MS`) live in `[vars]` (not `.dev.vars`) and are documented in `apps/web/wrangler.toml` — `OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` / `OUTBOX_MAX_ATTEMPTS` under `[env.relay.vars]` and `OUTBOX_RETENTION_MS` under `[env.pruner.vars]`. The schema itself lives in `packages/core/src/application/di/env.ts`.

### `SESSION_SECRET`

The HMAC key signing session cookies (32 characters minimum, `openssl rand -base64 48`) is a secret, not a `[vars]` entry — `wrangler.toml` does not inherit `[vars]` across `[env.*]` blocks, so a var would have to be duplicated in plaintext per environment. Set it once per stage on the **app Worker only**; relay / consumer / pruner / DLQ never touch a session and must not receive it.

```bash
wrangler secret put SESSION_SECRET --config wrangler.staging.toml
wrangler secret put SESSION_SECRET --config wrangler.production.toml
```

`.dev.vars` covers local dev. Skipping the remote `secret put` is invisible until deploy: the Cloudflare `ServerEnv` has no zod schema, so the Worker boots and every request then fails building its container.

## Session secret rotation

Session cookies are stateless: an HMAC-signed `{ uid, exp }` payload with no server-side record (`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`). Nothing can revoke a single session ahead of its expiry, which defaults to 7 days. **Rotating `SESSION_SECRET` is the only kill switch** — every previously issued cookie fails signature verification at once, which logs out every user.

Use it when a cookie or the key itself may have leaked:

1. Generate a replacement: `openssl rand -base64 48`.
2. `wrangler secret put SESSION_SECRET --config wrangler.<stage>.toml` — wrangler applies the new value to the running Worker.
3. Confirm an existing browser session now lands on `/login`.

Old and new keys are never accepted together — there is no rolling window, so the logout is immediate and total. To shrink the exposure window instead, lower `ttlMs` where the codec is constructed.

## Deployment

```bash
# staging
pnpm deploy:staging                  # app only
pnpm deploy:staging:relay
pnpm deploy:staging:consumer
pnpm deploy:staging:pruner
pnpm deploy:staging:dlq
pnpm deploy:staging:all              # all of the above
pnpm deploy:staging:all:dry          # dry run

# production
pnpm deploy:production               # app only
pnpm deploy:production:relay
pnpm deploy:production:consumer
pnpm deploy:production:pruner
pnpm deploy:production:dlq
pnpm deploy:production:all           # all of the above
pnpm deploy:production:all:dry       # dry run
```

## D1 migrations

The SQL lives under `packages/core/src/adapters/d1/migrations/` and is regenerated from `packages/core/src/adapters/d1/schema.ts` with `pnpm db:generate:cf`. (Bare `pnpm db:generate` is an alias of it.)

```bash
pnpm db:apply:local                    # apply to the local D1
pnpm db:apply:staging                  # apply to the staging D1
pnpm db:apply:production               # apply to the production D1
pnpm db:execute:local --file=...       # run an arbitrary SQL file locally
pnpm db:execute:staging --file=...     # run an arbitrary SQL file against staging
pnpm db:execute:production --file=...  # run an arbitrary SQL file against production
```

`pnpm db:migrate:cf` is an alias of `db:apply:local`, and bare `pnpm db:migrate` is an alias of it.

### Replacing a migration in place

`0000_initial` is regenerated in place rather than superseded by a `0001_*` while the schema is still pre-deployment. `wrangler d1 migrations apply` tracks applied migrations by **file name** in the `d1_migrations` table, so a D1 that already ran the old `0000_initial.sql` **skips the new contents without an error** — the tables never appear and the app fails later with `no such table: users`.

Delete the local D1 state before applying whenever the initial migration has been regenerated:

```bash
rm -rf apps/web/.wrangler/state/v3/d1
pnpm db:migrate:cf
```

Remote stages need the same treatment while pre-deployment: recreate the D1 (`wrangler d1 delete` / `create`, then paste the new `database_id`). Once the schema ships to an environment holding real data, stop replacing the tag and add `0001_*` migrations instead.

## Queues

Two queues per stage:

- `events` — the main event stream produced by the relay and consumed by the consumer Worker.
- `events-dlq` — receives messages that the consumer's `1 + max_retries` budget could not deliver.

Queue parameters (visibility timeout, `max_retries`, `max_batch_size`, `max_batch_timeout`) live in the `[[queues.consumers]]` blocks of the per-stage `wrangler.<stage>.toml`. Adjust them per stage and re-deploy the consumer / DLQ Workers to pick up the new settings.

## Cron triggers

Two cron triggers ship in `wrangler.<stage>.toml`:

| Worker  | Schedule       | Purpose                                                              |
| ------- | -------------- | -------------------------------------------------------------------- |
| Relay   | every 5 min    | Safety-net publish loop — kicks in when the Service Binding fails.   |
| Pruner  | daily          | Deletes processed (and not-quarantined) outbox rows beyond retention. |

## Retry budget

A message reaches the DLQ only after **both** retry budgets are exhausted:

| Budget                        | Default | Source                                                   |
| ----------------------------- | ------- | -------------------------------------------------------- |
| Relay publish attempts        | 2       | `DEFAULT_MAX_ATTEMPTS` / `OUTBOX_MAX_ATTEMPTS` var       |
| Consumer subscriber attempts  | 4       | `1 + max_retries` from the `[[queues.consumers]]` block   |

The user-visible attempt count is the **product** of those numbers (max 8 by default), so adjust them together when tuning. Once the relay budget is exhausted on a row, `processOutboxEvents` stamps `failed_at`, and the row stays out of the queue until manually re-driven.
