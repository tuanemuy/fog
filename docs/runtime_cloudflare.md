# Runtime: Cloudflare

The operational runbook for the reference runtime: what is deployed, what an operator can reach, and what they cannot.

## How to read this document

Every section that describes a procedure carries a **Reality** marker, and the marker answers one question only: **can this be run against production today?**

| Marker | Meaning |
| ------ | ------- |
| **Available** | Runnable against production today. |
| **Local only** | Runnable under `pnpm dev` / `pnpm preview`; there is no way to do it in production. |
| **None (#N)** | Runnable in neither, and issue #N receives the work. |

Two rules follow from that question, and both are easy to get wrong:

- **The marker is not decided by whether code exists.** Two maintenance RPCs — `list-quarantined-events` and `requeue-quarantined-event` — are implemented and have no caller anywhere in the tree; they are **None**, not Available. A third, `read-schema-version`, is implemented *and* has a caller, but that caller is the local diagnostic route only, so it is **Local only**.
- **The marker is not lowered because a later step is blocked.** `wrangler secret put`, `wrangler queues update` and `pulumi up` are commands you can run today, so they are **Available** even though the deploy they prepare for stops at #73. Where that boundary falls is shown by section headings — "before the deploy" versus "after the deploy" — not by the marker.

**A section whose reality is `None` still carries its full procedure, and says so at the top.** The alternative — leaving it out — reads as "there is a way and we did not write it down". Where a section describes something unimplemented, the first line names the issue that receives it and states what the current workaround is, or that there is none.

**This document records what is, not the gap between what is and what a spec says.** Where the two disagree, the disagreement is tracked on an issue and referenced by number here.

## 1. Topology

Two Workers, one Queue plus its dead-letter queue, and Durable Objects that hold everything else.

```text
                 ┌──────────────────────── request Worker ─────────────────────────┐
   HTTP ────────▶│ fetch: TanStack Start (SSR / RSC / server functions)            │
                 │ CPU-bound work: password hashing, token signing, export + zip   │
                 │ queue(): mail consumer + DLQ handler                       ◀────┼──┐ queues.consumers
                 └───────┬─────────────────────────────────────────────────────────┘  │
                         │ DO stub (script_name binding)                              │
                         ▼                                                            │
                 ┌───────────────────────── state Worker ──────────────────────────┐  │
                 │ owns the DO classes; fetch() always 404s                        │  │
                 │  ┌── User Data DO (one per user) ─────────────────────────────┐ │  │
                 │  │  domain tables + FTS5 index + jobs + outbox_events + _meta │ │  │
                 │  │  alarm(): Outbox relay pass, then local-job pass           │ │  │
                 │  └────────────────────────────────────────────────────────────┘ │  │
                 │  ┌── Identity Directory DO (bucketed, shared) ────────────────┐ │  │
                 │  │  credential_mappings + jobs + outbox_events + _meta        │ │  │
                 │  │  alarm(): same two passes                                  │ │  │
                 │  └────────────────────────────────────────────────────────────┘ │  │
                 └──────────┬──────────────────────────────────────────────────────┘  │
                            │ queues.producers: EVENTS_QUEUE                          │
                            ▼                                                         │
                            events queue ─────────────────────────────────────────────┤
                            │ max_retries = 3 exhausted                               │
                            ▼                                                         │
                            DLQ ──────────────────────────────────────────────────────┘
```

**The queue is the only path from the state Worker to the request Worker.** Nothing is delivered directly between them: the relay publishes into the events queue, and the request Worker's consumers are invoked from the events queue and from the DLQ. The only direct edge runs the other way — the request Worker taking a DO stub.

**Four things people expect to be Workers of their own are not**: the relay, the consumers, the pruning, and the dead-letter handling. There is no third Worker, and no fourth.

- **The relay runs inside each Durable Object's `alarm()`**, ahead of the local-job pass. It has no entry point of its own. Only the emitting DO's own tables can be written atomically with the update that produced the event, which is why the Outbox lives there and not in a dedicated object.
- **The consumers run in the request Worker's `queue()` handler** — the mail consumer and the DLQ handler both. That is `apps/web/app/worker/cloudflare/queueHandlers.ts`, wired by `packages/core/src/application/di/serverCloudflare.ts`. Hosting them there is what puts the mail provider's secret on the request Worker.
- **Pruning is not a job kind.** The job runner deletes retention-expired `done` and `published` rows at the tail of each wake-up.

**D1 is not coming back.** The binding is still declared in the request Worker's config and in Pulumi, and the migration scripts still exist, but **nothing in the runtime reads it** — every piece of user data lives in that user's Durable Object. Removing the remains is [#79](https://github.com/tuanemuy/fog/issues/79).

Two places under `docs/` mention D1 legitimately, and they are the reason "does the word D1 appear" cannot be used as a staleness check:

| File | What it says about D1 | Why it is correct |
| ---- | --------------------- | ----------------- |
| `docs/test.md` | Describes the `d1` Vitest project and its integration setup | The project exists in `vitest.config.integration.ts` and runs |
| `docs/backend_implementation_example.md` | Mentions the D1 adapter group as an adapter example | The adapter group exists under `packages/core/src/adapters/d1/` |

Neither describes D1 as the runtime's system of record. The staleness check is therefore not the word D1 but four English literals — the shared table of processed events, and standalone Workers for relaying, pruning and dead-lettering:

```bash
# from the repo root
git grep -in "processed_events\|relay worker\|pruner\|dlq worker" -- docs
# expected: exactly one hit — the line of this command itself, in this file.
# Anything else under `docs/` is the old design coming back.
```

Tenant isolation is structural: there is no `user_id` predicate that could be forgotten, because no code path can obtain another user's DO stub.

## 2. Configuration files and rendering

**Six files. Two are local, four are templates.**

| File | Worker | Rendered? |
| ---- | ------ | --------- |
| `apps/web/wrangler.toml` | request | no — local dev only |
| `apps/web/wrangler.state.toml` | state | no — local dev only |
| `apps/web/wrangler.staging.toml.tpl` | request | → `wrangler.staging.toml` (git-ignored) |
| `apps/web/wrangler.production.toml.tpl` | request | → `wrangler.production.toml` (git-ignored) |
| `apps/web/wrangler.state.staging.toml.tpl` | state | → `wrangler.state.staging.toml` (git-ignored) |
| `apps/web/wrangler.state.production.toml.tpl` | state | → `wrangler.state.production.toml` (git-ignored) |

Rendering is `pnpm cf:render:<stage>`, which runs `apps/web/scripts/render-wrangler.ts`. It reads `pulumi -C infra/cloudflare/pulumi/resources -s <stage> stack output --json --show-secrets` — **`--show-secrets` is part of the command**, and reproducing it by hand without the flag yields masked outputs — and substitutes six placeholders — `APP_URL`, `D1_DATABASE_ID`, `D1_DATABASE_NAME`, `EVENTS_QUEUE_NAME`, `DLQ_QUEUE_NAME`, `RESOURCE_PREFIX`. An unknown placeholder aborts the render rather than rendering an empty string. **One invocation renders both Workers' configs**, which is what keeps the state Worker's `name` and the request Worker's `script_name` from drifting apart.

**All four templates point `main` at a source entry.** There is no build-output path and no per-stage routing of `main`:

- request side: `main = "app/server.cloudflare.ts"`
- state side: `main = "app/worker/cloudflare/state.ts"`

**That the request side points at the TanStack Start source entry is the cause of #73**, not an incidental detail: `wrangler deploy` cannot resolve `#tanstack-start-entry`, `#tanstack-router-entry` or `tanstack-start-manifest:v`, which only the Vite plugin supplies. The templates' own headers say so.

### Durable Object migrations in the config

The state config declares its DO classes once:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserDataDurableObject", "IdentityDirectoryDurableObject"]
```

`new_sqlite_classes` — not `new_classes` — is what gives the classes the SQLite backend, without which `ctx.storage.sql` does not exist. `vitest.config.do.ts` mirrors this with `useSQLite: true`, and `apps/web/app/worker/cloudflare/__tests__/wranglerConfig.test.ts` pins both.

**`[exports.*]` is not used, and should not be introduced.** Wrangler's newer export syntax is mutually exclusive with `[[migrations]]`, the move is one-way, and `wranglerConfig.test.ts` pins the `[[migrations]]` shape. A config that adopted `[exports.*]` would have to abandon the migration tag that already names the deployed classes.

### `script_name` fails silently

The request config's DO bindings name the state Worker:

```toml
[[durable_objects.bindings]]
name = "USER_DATA"
class_name = "UserDataDurableObject"
script_name = "tanstack-start-template-state"   # must equal the state config's `name`
```

**When those two strings disagree, the Vite Cloudflare plugin does nothing and reports nothing.** Config load succeeds, boot succeeds, the top page renders — and the first DO stub call fails. Two things guard it: `wranglerConfig.test.ts` pins that the names match, and `GET /__diagnostics/schema-version` makes one real round trip from the request Worker into a Durable Object. Neither the top page nor any unit test exercises the binding, so **keep that diagnostic route** — it is the regression gate for a failure mode that is otherwise invisible until production traffic hits it.

### Queues

One events queue and one DLQ, and the two bindings live on **different** Workers:

| Binding | Worker | Config |
| ------- | ------ | ------ |
| `[[queues.producers]] EVENTS_QUEUE` | **state** | `wrangler.state.*.toml` |
| `[[queues.consumers]]` events (`max_batch_size 25`, `max_batch_timeout 30`, `max_retries 3`, `dead_letter_queue`) | **request** | `wrangler.*.toml` |
| `[[queues.consumers]]` DLQ (`max_batch_size 25`, `max_batch_timeout 30`, `max_retries 1`, no DLQ of its own) | **request** | `wrangler.*.toml` |

The producer is on the state Worker because the relay publishes from inside `alarm()`. The consumers are on the request Worker because that is where the CPU-bound work and the mail provider's secret live — and because "who owns completion" (the queue's retry and its DLQ) is what the Outbox classification asks, not "which Worker does the consumer run in".

The DLQ is recognised at runtime by its name suffix (`-dlq`, in `queueHandlers.ts`). That the constant and the provisioned queue name agree is a naming convention held by the wrangler configs and the Pulumi resources; `wranglerConfig.test.ts` pins both sides of it.

### Pulumi

Two stacks under `infra/cloudflare/pulumi/`:

| Stack | Provisions | Notes |
| ----- | ---------- | ----- |
| `resources` | Zone, D1 database, events queue, DLQ | Run **before** `wrangler deploy`; its outputs feed `cf:render` |
| `routes` | one `WorkersDomain` binding the app hostname to the request Worker | Run **after** `wrangler deploy` — Cloudflare rejects a custom-domain binding for a service that does not exist |

**Pulumi does not provision Durable Object namespaces.** Those are created by `wrangler deploy` from the `[[migrations]]` block. Nothing in the Pulumi state knows they exist.

`{ protect: true }` is set on the **D1 database and nothing else**. It stops `pulumi destroy` and stops a resource-replacing edit from deleting the database. Keep it: D1 is still declared as a persistent resource, and an accidental destroy is not recoverable through Pulumi.

**Reality: Available.** To remove the protection when [#79](https://github.com/tuanemuy/fog/issues/79) retires D1:

```bash
# from the repo root
pulumi -C infra/cloudflare/pulumi/resources -s <stage> state unprotect \
  'urn:pulumi:<stage>::tanstack-start-template-cf-resources::cloudflare:index/d1Database:D1Database::db'
# then remove the resource from index.ts and run `pulumi up`
```

`pulumi state unprotect --all` clears every protected resource in the stack at once and should not be used here — there is exactly one, and naming it is the point.

## 3. Secrets: ownership and procedure

**Reality: Available** (installing a secret is a command you can run today; the deploy it prepares for is blocked by #73).

`apps/web/.dev.vars.example` is the authority for ownership. Five secrets are declared there:

| Secret | Owner | What it is |
| ------ | ----- | ---------- |
| `SESSION_SECRET` | **request** | HMAC key signing session cookies. Empty by default; the Worker refuses every request until it is set |
| `MAIL_PROVIDER_API_KEY` | **request** | Mail provider credential. The consumer runs in `queue()` on this Worker, so the provider is called from here |
| `DIRECTORY_ROUTING_SECRET` | **request** | HMAC key mapping a canonical address to its Identity Directory bucket. Bucket selection happens in the stub-selection adapter, *before* any DO is entered |
| `IDENTITY_MAIL_ENCRYPTION_KEY` | **state** | AES-256-GCM key protecting `credential_mappings.encrypted_canonical`. Never leaves the DO |
| `PROVIDER_IDEMPOTENCY_KEY` | **state** | HMAC key each DO derives `providerIdempotencyKey` from. Never leaves the DO |

**`DIRECTORY_ROUTING_SECRET` and `IDENTITY_MAIL_ENCRYPTION_KEY` are deliberately given to opposite Workers.** The request Worker can compute *where* a credential lives but cannot read the address back; the state Worker can read the address back but cannot compute where it lives. Handing either key to both Workers collapses that split, and no code notices.

**So do not write "the derivation keys never leave the DO" without qualification.** Of the two derivation keys declared here, both do stay inside the DO (`IDENTITY_MAIL_ENCRYPTION_KEY`, `PROVIDER_IDEMPOTENCY_KEY`). `DIRECTORY_ROUTING_SECRET` is a *mapping* key and lives on the request Worker by design — it is not one of them. Stating the rule too broadly is how it ends up copied into the state Worker "for consistency".

**This table is not the full roster of secrets.** Three known gaps:

- The **third derivation key**, the reset-token key, is declared by the password-reset slice ([#12](https://github.com/tuanemuy/fog/issues/12)).
- The **`previous` keyring entries and the rotation key commitment** arrive with [#67](https://github.com/tuanemuy/fog/issues/67).
- `apps/web/worker-configuration.d.ts` already declares **two secrets whose ownership nothing states** — `AI_CLIENT_TOKEN_SECRET` and `IDENTITY_RESET_TOKEN_KEY`. That file is generated by `wrangler types`, which fills secret entries from the local git-ignored `.dev.vars`; it is a per-machine artefact and cannot be read as a roster. Whoever lands those two owns writing them into `.dev.vars.example`.

### Generating and installing

```bash
openssl rand -base64 48        # any of the five
```

Install each secret **against the config of the Worker that owns it** — the `--config` flag is the whole of the ownership enforcement:

```bash
# from apps/web — `wrangler` is a devDependency of @repo/web, and the
# --config paths are relative to that directory. From elsewhere, run it as
# `pnpm --filter @repo/web exec wrangler secret put …`.
wrangler secret put SESSION_SECRET               --config wrangler.staging.toml
wrangler secret put MAIL_PROVIDER_API_KEY        --config wrangler.staging.toml
wrangler secret put DIRECTORY_ROUTING_SECRET     --config wrangler.staging.toml
wrangler secret put PROVIDER_IDEMPOTENCY_KEY     --config wrangler.state.staging.toml
wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEY --config wrangler.state.staging.toml
```

Getting one wrong **works locally and breaks first in staging** — see below.

### Rotation policy

| Secret | Rotation | Consequence of rotating |
| ------ | -------- | ----------------------- |
| `SESSION_SECRET` | rotate freely | every session cookie is invalidated; users log in again |
| `MAIL_PROVIDER_API_KEY` | rotate freely, provider-side | none |
| `DIRECTORY_ROUTING_SECRET` | **never rotate in place** | the bucket of every existing credential changes and nothing is findable; rotating it is the mapping-key transfer, [#67](https://github.com/tuanemuy/fog/issues/67) |
| `IDENTITY_MAIL_ENCRYPTION_KEY` | **never rotate in place** | every `encrypted_canonical` becomes undecryptable; rotating it is the `rotate-encryption` procedure, [#67](https://github.com/tuanemuy/fog/issues/67) |
| `PROVIDER_IDEMPOTENCY_KEY` | rotate freely | in-flight deliveries derive a different key and the provider may send one duplicate; delivery is at-least-once already |

### The split does not hold locally

`wrangler dev -c wrangler.toml -c wrangler.state.toml` resolves `.dev.vars` relative to the config directory, and both configs sit in `apps/web/`. **Every entry in `.dev.vars` is therefore visible to both Workers locally** — measured: the state Worker also receives `SESSION_SECRET` and `DIRECTORY_ROUTING_SECRET`. The ownership above only becomes real from staging onward, where `wrangler secret put --config` puts each secret on one Worker.

**A misattributed secret is invisible locally for exactly this reason.** Do not use `pnpm dev` to confirm ownership.

## 4. Deploying

### 4.1 Steps you can run today (before the deploy)

**Reality: Available.**

**Step 0 — prerequisites.** Every stack in this repository ships unconfigured, and step 1 stops without them. **The failure is not self-explaining**: `config.require` only catches a key that is *absent*, and the shipped placeholders are present values, so `pulumi up` accepts them and fails later against the Cloudflare API instead.

- **Fill in the Pulumi stack config.** `infra/cloudflare/pulumi/resources/Pulumi.<stage>.yaml` requires five values — `accountId` (shipped as the literal `REPLACE_WITH_CF_ACCOUNT_ID`), `zoneName` (`example.com`), `appHostname`, `appUrl`, `resourcePrefix` — and `infra/cloudflare/pulumi/routes/Pulumi.<stage>.yaml` requires two, `accountId` (the same placeholder) and `resourcesStackRef` (whose `organization/` segment is the Pulumi organisation or user that owns the resources stack). **No stack has been `up`ed in any stage** — that is the same fact chapter 5 reads as "there is no queue to ask".
- **Be logged in to Pulumi, with a Cloudflare provider credential.** `pulumi login` against whichever backend holds the stacks, plus a Cloudflare API token in the environment the provider reads (`CLOUDFLARE_API_TOKEN`), scoped to edit the zone, D1 and Queues.
- **Be authenticated for `wrangler` too.** `wrangler login`, or the same `CLOUDFLARE_API_TOKEN`. **`wrangler` is a devDependency of `@repo/web` and of nothing else**, so every `wrangler` command in this document runs from `apps/web/` — or from anywhere as `pnpm --filter @repo/web exec wrangler …`.

```bash
# from the repo root
# 1. persistent resources
pulumi -C infra/cloudflare/pulumi/resources -s <stage> up

# 2. render both Workers' configs from those outputs
pnpm cf:render:<stage>

# from apps/web
# 3. install the five secrets against their owning config (see chapter 3)

# 4. set the DLQ retention out of band — it is not a wrangler key
wrangler queues update <prefix>-events-dlq --message-retention-period-secs 600
```

Step 4 is **mandatory, not an adjustment**. `wrangler queues create/update` omits `settings.message_retention_period` from the request when the flag is absent, so an unconfigured queue keeps Cloudflare's documented default of 4 days — at which both delivery constraints (chapter 12) are broken at once. `wranglerConfig.test.ts` pins the seconds in the template headers against the declared `dlqRetentionMs`, so moving one without the other turns the suite red. **What is pinned is the instruction, not the queue**: whether anyone ran it is observable nowhere in this repository.

### 4.2 Steps that only mean something after the deploy

**Reality: None ([#73](https://github.com/tuanemuy/fog/issues/73)) for the request Worker half.**

```bash
# from the repo root (both are root scripts that delegate to @repo/web)
# 5. state Worker FIRST, then the request Worker
pnpm deploy:<stage>:state     # works
pnpm deploy:<stage>           # fails while bundling — #73
pnpm deploy:<stage>:all       # runs the two in that order; only the first half lands

# 6. bind the hostname
pulumi -C infra/cloudflare/pulumi/routes -s <stage> up
```

**The order is not a preference.** The request Worker's DO bindings name the state Worker's script, and a binding cannot be created against a script that does not exist. The routes stack comes last for the same reason one level up: Cloudflare rejects a custom-domain binding for a service that has not been uploaded.

`pnpm deploy:<stage>` fails today because `main` is the TanStack Start source entry and `wrangler` cannot resolve its virtual modules — the same unresolved point that keeps `pnpm start` from booting. Until [#73](https://github.com/tuanemuy/fog/issues/73) closes, **the request Worker cannot be deployed at all**, and everything downstream of it in this document is unreachable in production regardless of what else is true.

### 4.3 Rollback

**Data is never rolled back.** Schema is forward-only; there are no down migrations.

Code can be rolled back, but a DO whose `_meta.schema_version` is ahead of what the code understands **fails closed** (chapter 6). The gate compares the stored version against the target declared by **the state Worker's own bundle** (`migrationGate.ts`), so both ways a DO can get ahead of its code are on that side: **rolling the state Worker back**, and the **propagation window of a state deploy**, where an object migrated by an isolate running the new bundle is next served by one still running the old. Therefore:

> **A release that advances the schema is a release that cannot be rolled back.** Treat it as one-way at plan time, not at incident time.

**A fail-closed DO also burns the messages already published from it.** The consumer picks one up and calls that DO's send-materials RPC; the RPC runs behind the migration gate, the gate answers `SystemError`, the consumer retries until `max_retries` is exhausted, and the message lands in the DLQ. **The DLQ handler acks it. There is no way to get it back.** The only exit is the user asking again.

The fallback for a bad schema release is PITR (chapter 11), which restores **one DO at a time** and cannot restore several to a common point.

### 4.4 The skew window, and what it burns

Deploys are not atomic across the two Workers, and the deploy order decides which side is ahead.

> **The state Worker lands first, so the emitter runs ahead of the consumer.** A DO on the new bundle may publish an `event.type` — or a routing key — that the deployed request Worker cannot route. `handleEventsBatch` answers both with `message.retry()` rather than `ack()`, the retries are exhausted, and the message lands in the DLQ. **The DLQ handler acks it. There is no way to get it back.** The only exit is the user asking again.

Retrying rather than acking is deliberate: an ack would discard a message against an at-least-once contract, and the DLQ is the disposition `spec/async/index.md` gives a consumer failure. The window stays open for exactly as long as the two deploys are apart, which is one more reason not to leave `deploy:<stage>:all` half-run.

**The migration gate is not what burns a message in this window.** It compares against the target the state Worker's own bundle declares, so advancing the schema forward never puts a DO ahead of the code that owns it. The gate's two cases are in 4.3.

The two directions are not symmetric, and confusing them is the common mistake:

- **DO side** — a DO that is not relaying — a fail-closed one (4.3) — piles up `outbox_events` rows. **That backlog is not lost delivery.** The rows are still there and flow on the first wake-up after the code catches up.
- **Queue side** — a message that was already published is past the point where the DO can help. It is burned, here and in 4.3 alike.

Section 8.6 refers back to this paragraph rather than restating it.

### 4.5 `pnpm preview`

**Reality: Local only.**

`pnpm preview` serves the build output through `vite preview`, so `pnpm build` (= `build:cf`) must have run first; it reads `.wrangler/deploy/config.json` to find that output. **`APP_URL` is pinned to `http://localhost:3000` in `wrangler.toml`**, and `vite preview` picks its own port — so `og:url` and the canonical link will disagree with the address in the browser bar. That is expected in preview and is not a signal of a misconfiguration.

`pnpm start` (`wrangler dev` over both configs) does not boot — [#73](https://github.com/tuanemuy/fog/issues/73), same cause as the failing deploy.

## 5. Out-of-band settings nothing here can observe

Three settings govern production behaviour and **none of them can be read back from this repository.** They are collected here so that "the declared value" is never mistaken for "the deployed value".

| Setting | Where it actually lives | Declared counterpart |
| ------- | ----------------------- | -------------------- |
| DLQ `message_retention_period` | Queue resource, set by `wrangler queues update --message-retention-period-secs` | `dlqRetentionMs` = 600,000 ms |
| Queue maximum retry period | nowhere — a consequence of `max_retries`, `retry_delay` and `max_batch_timeout` | `queueMaxRetryPeriodMs` = 300,000 ms |
| Per-origin rate limiting (WAF) | Cloudflare dashboard / a WAF rule resource nobody has written | none |

**`message_retention_period` does not bound how long a message sits in the DLQ.** It bounds how long the queue keeps a message *no consumer has taken*. A consumer **is** bound to the DLQ and it acks everything (8.6), so dwell time is set by how fast batches form. Raising this number buys an operator no time whatsoever; what it does is widen the worst-case age of a message on its way to the handler, which is what the two delivery constraints read it as.

`queueMaxRetryPeriodMs` has no wrangler key of its own, so the declared value is **a budget, not a guarantee**. `createDeliveryTuning` only checks it covers `eventsMaxRetries * (eventsRetryDelayMs + eventsMaxBatchTimeoutMs)` — a floor of 90,000 ms against the declared 300,000, **recomputed from those three declarations and pinned to that number from both sides by `packages/core/src/application/delivery/__tests__/tuning.test.ts`**, so moving any of them turns the suite red rather than leaving the figure behind. Whether the platform actually stops retrying inside that window is unverifiable here.

**Two of the three are settable at all** — the DLQ retention through `wrangler queues update`, and the WAF rule in the dashboard. **The queue's maximum retry period is not a setting at all** and moves only when the three consumer values it derives from do. **Whether the WAF rule is in place carries its marker in 9.4 and nowhere else**; this chapter is about readback, not about reach. `wrangler queues update` and `wrangler queues info <name>` — the one command that would show the DLQ retention back — **mean something only after step 1 of 4.1**: each needs a `CLOUDFLARE_API_TOKEN` and a provisioned queue, and no Pulumi stack has been `up`ed (`Pulumi.<stage>.yaml` still carries `REPLACE_WITH_CF_ACCOUNT_ID`), so **there is no queue to update or to ask**. Once a stack is up, `queues update` is the setting and `queues info` is the check. **After the deploy** none of the three is readable from this repository.

## 6. Schema migration and local state

### Lazy migration

Each DO carries `_meta.schema_version`. On the first RPC of a wake-up the migration gate compares it to the target the code understands and applies the missing steps **inside one `transactionSync`, together with the version update** — "applied but the version did not move" is not representable. Steps are re-runnable (`CREATE TABLE IF NOT EXISTS`), but re-runnable is not bounded: a `CREATE INDEX` on a large table is idempotent and still may not finish in one input.

**Until the first production deployment there is no v2.** Every slice extends v1 in place and `schema_version` stays at 1. Without that rule, one slice would add a v2 while another extended v1 and the fail-closed gate's expected maximum would diverge between them. **The only shape a schema change may take today is therefore: edit v1's DDL, add no migration step, and leave `schema_version` where it is.** **The premise is that no DO instance exists remotely** — there is no route that reaches one, so none has been created. That premise cannot be checked today (no credentials, no deployed stack), so it is recorded as an assumption rather than a verified fact. **If a v1 DO does turn out to exist, an edit to v1's DDL never reaches it: the gate skips every step whose `version` is at or below the stored `schema_version`, so the statement is not executed at all.** (`CREATE INDEX IF NOT EXISTS` is there to make the first application re-runnable, not to carry a changed definition to an object that already ran it.) The fix at that point is a v2 step and an advanced `targetVersion`, not an edit.

### Fail-closed

A DO whose `schema_version` is **greater** than the code's target refuses work and answers `SystemError`. Writing rows a build does not understand is worse than being unavailable.

- **The gate applies to `alarm()` too.** A fail-closed DO's alarm executes no jobs, re-arms, and returns.
- **It does not mark anything `poison`.** The cause is deployment state, not data; correct code returning fixes it.
- **The re-arm interval is fixed, with no backoff** (`failClosedRearmIntervalMs`, 300,000 ms). Backing off would make a DO that has been behind for a long time slow to notice that it no longer is.
- **It does not call `deleteAlarm()`.** A disarmed DO with no traffic would never discover the code had caught up.
- **It does not relay**, so `outbox_events` rows accumulate — see 4.4 for why that backlog is not lost delivery.

Recovery is simply deploying code that understands the version. Nothing needs to be re-run by hand.

**Reality of detecting it: Local only.** `GET /__diagnostics/schema-version?locator=dir:g1:b0` answers the version for one bucket, and the route only exists where `DIAGNOSTICS_ENABLED = "true"` — declared in `wrangler.toml` and deliberately absent from all four templates. In production there is no diagnostic route and no cross-DO sweep; see 7.4.

### Discarding local DO state

**Reality: Local only.** There is no npm script; the command is the procedure.

```bash
# from the repo root
rm -rf apps/web/.wrangler/state
```

**This is mandatory after any index-definition change.** An initialised local DO already carries `schema_version = 1`, so the gate skips v1's step and the edited DDL is never issued against it — the object keeps the old definition forever and `pnpm dev` silently runs the old plan.

**No `EXPLAIN QUERY PLAN` test is affected by any of this**, and that holds for ones added later rather than for a fixed list: every such assertion runs in the `durable-objects` vitest project, whose `include` claims the whole of `packages/core/src/adapters/cloudflare/`, and `vitest.config.do.ts` sets no `miniflare.persist`, so the DO pool builds its objects in memory and reads zero bytes of `.wrangler/state`. At the time of writing they are `__tests__/alarmSchedule.integration.test.ts` for the Alarm's re-arm minima, `__tests__/rowRunner.integration.test.ts` for the claim `SELECT`, and `stores/__tests__/memoRepository.integration.test.ts` for the timeline seeks and scans. If one is red, local state is not the reason.

### Reading what is inside a DO

**Reality: Local only.**

**`sqlite3` is a prerequisite here and is not a dependency of this repository** — install it from the platform's package manager. Paths below are relative to the repo root.

Each DO's SQLite file is on disk:

```text
apps/web/.wrangler/state/v3/do/<script>-<ClassName>/<hash>.sqlite
```

The hash is not the locator, but the locator is inside the file: miniflare adds a table `__miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)` holding exactly the string passed to `idFromName`. Sweeping the directory builds the reverse map:

```bash
# from the repo root
for f in apps/web/.wrangler/state/v3/do/*/*.sqlite; do
  printf '%s\t%s\n' "$(sqlite3 "$f" "SELECT name FROM __miniflare_do_name" 2>/dev/null)" "$f"
done
```

**One file exists per bucket a stub has been selected for, and none for the rest.** The directory is not pre-populated: a single sign-up on fresh state prints one Identity Directory line — whichever bucket that address hashed into, `dir:g1:b0` … `dir:g1:b15` — and one User Data line named with the user's `userId` verbatim. Sixteen Identity Directory files is what the sweep prints against a state where every bucket has had a stub selected for it, which takes many accounts. (`metadata.sqlite` in each directory is miniflare's own and holds `_cf_ALARM`; it has no `__miniflare_do_name`, so the sweep prints its line with an empty name field.)

Two states look like damage and are not:

- **Right after `rm -rf apps/web/.wrangler/state` there is no `<hash>.sqlite` at all.** `pnpm dev` recreates each class's directory with `metadata.sqlite` alone, and querying that file answers `no such table: __miniflare_do_name`. The first `<hash>.sqlite` appears when a request selects a stub.
- **A file may contain nothing but `__miniflare_do_name`.** That is the normal state of a DO that was addressed but never passed through the migration gate — the bucket exists because a stub was selected for it, and no business table has been created. **Do not read an empty file as "the migration failed".**

To see `jobs`, `outbox_events`, `_meta` and the domain tables you have to drive an operation that enters the gate — signing up or logging in is enough:

```bash
sqlite3 <file> "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY 1"
```

**Those tables are split across the two classes, never gathered in one file.** An Identity Directory file carries `credential_mappings`, `jobs`, `outbox_events` and `_meta`; a User Data file carries `account`, `user_settings`, `credential_locators`, `operations`, `jobs`, `outbox_events` and `_meta`. A single sign-up therefore populates two files, one of each class.

**The limit is production, and it is total.** There is no way to touch a deployed DO's storage. The only thing observable from outside is the single number `read-schema-version` returns — and that entry has no caller in production either (8.2).

## 7. The Alarm

### 7.1 One Alarm, two tables

Each DO has exactly one Alarm and it multiplexes `jobs` and `outbox_events`. Every wake-up runs, in order:

1. re-arm and confirm persistence
2. the migration gate
3. (a) the relay pass, then (b) the jobs pass
4. prune, then recompute the wake-up from both tables and re-arm

**Each pass holds its own count limit** (`relayMaxRowsPerPass` and `jobsMaxJobsPerPass`), and **both run on every wake-up**. Sharing one limit would let a backlog in either pass starve the other.

### 7.2 Re-arming

The next wake-up is the minimum of four separate statements — never one composed expression:

```sql
SELECT min(next_run_at) AS v FROM jobs
  WHERE status IN ('pending','running') AND status = 'pending'      -- jobs_runnable_idx
SELECT min(lease_until)  AS v FROM jobs
  WHERE status = 'running'                                          -- jobs_lease_idx
SELECT min(next_run_at) AS v FROM outbox_events
  WHERE status IN ('pending','publishing') AND status = 'pending'   -- outbox_runnable_idx
SELECT min(lease_until)  AS v FROM outbox_events
  WHERE status = 'publishing'                                       -- outbox_lease_idx
```

`min(max(next_run_at, lease_until))` as a single statement would need an index keyed on that expression. None exists, so it would scan both runnable sets on every wake-up.

**Only the runnable statements carry a redundant predicate, and they need it.** SQLite does not infer that `status = 'pending'` implies `*_runnable_idx`'s partial predicate `status IN ('pending','running')`, so the `IN` term is written out to satisfy the predicate syntactically. The leased statements need no such term because `*_lease_idx` leads on `status` — a column that is redundant with that index's own partial predicate and is there for exactly this reason.

**Dropping either mechanism costs a plan, not an answer.** Remove the redundant term or the leading column and every statement still returns the right time; it just falls back to `*_completed_idx` and scans a status group. Nothing throws.

That each index exists and is named as declared is pinned by `packages/core/src/adapters/cloudflare/__tests__/schema.integration.test.ts`, which compares the whole list, so a deletion or a rename turns that file red. **What only an `EXPLAIN QUERY PLAN` assertion catches is the change that keeps every name and the count and breaks the plan anyway** — a reworked column list or a *widened* partial predicate — because it asserts the plan a statement resolves to. "No `SCAN`" would not do: the fallback to `*_completed_idx` is a `SEARCH` as well. **Two such assertions stand over these two tables' indexes, on different statements:** `__tests__/alarmSchedule.integration.test.ts` for the four re-arm minima above, and `__tests__/rowRunner.integration.test.ts` for the claim `SELECT` (12.5). Other tables carry their own; the domain indexes are not in this section's scope.

**Which of the two goes red is stated only as a cell of the table below, never in prose.** A row is one index and one kind of change — and a change to a *statement* is one too, belonging to the index its seek hangs on. A kind of change with no row there is unmeasured against these two, and nothing here says which of them it would turn red. Measured on the DO pool, identically for `jobs` and `outbox_events`:

| Index | Change | Re-arm assertion | Claim assertion |
| ----- | ------ | ---------------- | --------------- |
| `*_runnable_idx` | dropped from the DDL altogether | **red** (the runnable minimum falls to `*_completed_idx`: `SEARCH jobs USING INDEX jobs_completed_idx (status=?)`) | **red** (the same fallback) |
| `*_runnable_idx` | renamed with its definition untouched, to `*_runnable_v2` | **red** (the plan is still a seek, but it names the new spelling: `SEARCH jobs USING COVERING INDEX jobs_runnable_v2 (status=?)`) | **red** (likewise, and with the same index constraints as before: `SEARCH jobs USING INDEX jobs_runnable_v2 (status=? AND next_run_at>? AND next_run_at<?)`) |
| `*_runnable_idx` | reworked column list, to `(next_run_at, status)` | **red** | **red** |
| `*_runnable_idx` | widened partial predicate, a further status added | **red** | **red** |
| `*_runnable_idx` | narrowed to `status = 'pending'` | green (the runnable minimum spells that same term, so it stays satisfied) | **red** (`IN ('pending','<leased>')` stops being satisfied; falls to `*_completed_idx`) |
| `*_runnable_idx` | narrowed to `status IN ('pending')` | **red** (SQLite does not derive the one-element `IN` from the equality) | **red** |
| `*_runnable_idx` | a column appended, to `(status, next_run_at, attempt)` | green | green — the claim's plan is unchanged down to its index constraints (`status=? AND next_run_at>? AND next_run_at<?`) |
| `*_runnable_idx` | the re-arm's runnable minimum drops its redundant `IN` term, leaving `WHERE status = 'pending'` | **red** (nothing is left to satisfy the partial predicate syntactically; it falls to `*_completed_idx`) | green — the claim spells an `IN` term of its own |
| `*_runnable_idx` | the claim `SELECT` drops its redundant `next_run_at IS NOT NULL` | green — the re-arm minima carry no such term | green — deliberate: that assertion matches `next_run_at<` — the due upper bound alone — rather than the full constraint list, so losing this harmless lower bound does not turn it red |
| `*_runnable_idx` | the claim `SELECT` drops its due upper bound from the index constraint (`next_run_at <= ?` replaced by `attempt <= ?`) | green — the re-arm minima carry no due bound at all | **red** (the index name is still `*_runnable_idx` and the plan is still a `SEARCH`; what is gone is the `next_run_at<` term that assertion matches) |
| `*_runnable_idx` | the claim `SELECT` puts the leased status back into a bind, `IN ('pending', ?)` | green — the re-arm minima are other statements and are parameterless | **red**, in whichever of two ways the edit is made: left as it stands the assertion dies on `Wrong number of parameter bindings for SQL query.` before reaching a single expectation, and given the third dummy value that silences it the plan falls to `*_completed_idx` and the index name no longer matches |
| `*_lease_idx` | reworked column list, to `(lease_until, status)` | **red** | green — the claim never reads this index |
| `*_lease_idx` | widened partial predicate, a further status added | **red** | green — the claim never reads this index |
| `*_lease_idx` | an added term, e.g. `AND lease_until IS NOT NULL` | **red** (the leased minimum spells the predicate's only term) | green — the claim never reads this index |
| `*_lease_idx` | a column appended, to `(status, lease_until, attempt)` | green | green — the claim's plan is unchanged, and the claim never reads this index |

**Twelve of the fifteen rows above are red in one column or the other. The three that are green in both are the two appended-column rows and the claim's dropped `next_run_at IS NOT NULL`, and their cells say why.**

**The same bar reaches the code.** A comment in `rowRunner.ts`, `schema/plan.ts` or either EQP test that states what a guard catches names an index or a statement together with the concrete spelling of the change — "narrowed to `status = 'pending'`", "puts the leased status back into a bind" — so that it resolves to one or more cells above, and never quantifies over a class of change ("narrowing", "any change", "this is the whole of the protection"): what such a sentence lacks is not truth but any way to measure it.

**Limits** — both assertions run against an empty DO with **no `sqlite_stat1`**, so the plan under gathered statistics is unmeasured, and the plan is SQLite's, hence dependent on the version workerd bundles.

**Leased rows count by `lease_until`, not `next_run_at`.** The claim CAS requires the lease to have expired, so a DO holding nothing but claimed rows would otherwise re-arm on a past `next_run_at`, wake, claim nothing, and re-arm on the same past time — spinning. On a leased row `next_run_at <= lease_until` always holds, so the four-way minimum agrees with the "count leased rows as `max(next_run_at, lease_until)`" reading.

### 7.3 Late and duplicate work

**Duplicates are not a fault.** Job execution and event delivery are both at-least-once: the DO may reset immediately after a send succeeded but before the row was finalised, and the work runs again. Every job implementation and every consumer is idempotent by contract. **Two identical emails are the expected worst case of a healthy system**, not an incident.

Lateness is what to look for instead.

**Reality: Local only.** What identifies it:

- `outbox_events` rows in `pending` whose `next_run_at` is well in the past — the Alarm is not firing, or the DO is fail-closed
- rows in `publishing` whose `lease_until` is in the past — a wake-up claimed them and died between publish and finalize; the next wake-up re-claims them
- a rising `attempt` on the same row — publishes are failing and backoff is pushing it out
- rows in `quarantined` — attempts are exhausted; see 8.4

Locally, read them from the DO's SQLite file (chapter 6). **In production none of this is observable**: `read-delivery-backlog` is unimplemented and no maintenance entry has a caller. Active notification of stuck delivery is [#23](https://github.com/tuanemuy/fog/issues/23).

### 7.4 Finding a fail-closed DO

**Reality: Local only, and even locally only one at a time.**

`GET /__diagnostics/schema-version?locator=dir:g1:b0` answers for the bucket you name. It takes bucket-shaped locators only — accepting the `userId` form would answer "does this account hold data", which is exactly the disclosure the restriction exists to prevent.

**There is no cross-DO sweep, in production or locally.** Durable Objects cannot be enumerated by the platform, `list-bucket-user-ids` is unimplemented, and the reverse map from a DO's internal id to a `userId` does not exist. In production even the single-bucket check is gone, because the diagnostic route is not registered in any deployed stage. **A fail-closed DO is found by a user reporting an error, or not at all.** Chapter 14 tracks it.

### 7.5 `sweep-reset-tokens` keeps a bucket armed

**Reality: None ([#12](https://github.com/tuanemuy/fog/issues/12)).** This is a consequence of the design, not something observable today: the kind is declared, no handler is registered for it, and no usecase enqueues it — nothing below happens until the password-reset request path lands.

`sweep-reset-tokens` is enqueued unconditionally on every password-reset request, whether or not the address is registered — the whole point of the throttle-window design is that a registered and an unregistered address produce identical writes.

**The consequence is billing and observability, not correctness.** A bucket that has handled any reset request holds an armed Alarm and keeps waking until the sweep drains. Because Identity Directory DOs are shared by many users, a single active bucket can stay armed more or less continuously. Expect wake-up counts on Identity Directory objects to track reset traffic rather than registered-user counts.

## 8. Operating delivery

### 8.1 Nobody can watch delivery end to end

**A single message's journey cannot be observed from one place**, and this is structural.

The division of responsibility is one line: **before the queue, or after it.**

- **Before** — the emitting DO owns the row. It claims, publishes, and finalizes to `published`. If it cannot publish, it backs off and eventually quarantines.
- **After** — the queue's retry and its DLQ own completion. **No ack is written back to the emitting DO.**

The ack is missing on purpose. Writing one back would itself be at-least-once and would therefore need a third quarantine of its own, and the DO would have to distinguish "not delivered" from "not processed" — two states, one of which it can never observe. So `published` means "handed to the queue" and nothing more.

That is why there are two operator paths, not one: **the DO's maintenance entries** (8.3–8.5) and **the DLQ handler** (8.6). Neither sees the other's half.

### 8.2 The operator path (design; not a procedure)

> **Reality: None ([#80](https://github.com/tuanemuy/fog/issues/80)). Every entry described in 8.3–8.5 is unreachable — all seven of them, including the two that are implemented. There is no workaround.** `wrangler` has no command that calls a Durable Object RPC; the state Worker's `fetch` answers 404 unconditionally and routes nothing; and the request Worker's only DO call that reaches a maintenance entry is the local-only schema-version diagnostic — its business RPCs and the mail consumer's send-materials RPC (4.3) do call Durable Objects, and reach none of the entries in chapter 10. Outside a test process, no code path invokes them.

The design below is settled so that #80 implements a contract rather than inventing one.

**(a) Shape.** `POST /__operator/<entry>` on the request Worker. **The handler module goes in `apps/web/app/worker/cloudflare/`** — a bare Worker handler that goes through no TanStack Start code, the same shape as `queueHandlers.ts`. **The wiring point is separate**: `apps/web/app/server.cloudflare.ts`'s `fetch` calls it beside the diagnostic handler, which is defined in that file itself rather than in `worker/cloudflare/`. The body is validated at the transport boundary with Zod; the DO stub is taken from the existing `doStubs.ts` seam; the RPC envelope is unwrapped by `callDurableObject` and its `SerializedError` mapped to a status.

**Locator validation is per entry and is not just a regular expression.** `DIRECTORY_LOCATOR` (`^dir:g\d+:b\d+$`) admits any generation and any bucket number, and `IdentityDirectoryDurableObject` is constructed with `allowInitialize: true` — so a request for `dir:g9:b999` would **permanently create a new, empty Identity Directory DO** that nothing can ever find again. Each entry declares which locator forms it accepts, and bucket-shaped locators are additionally checked against the generations and bucket counts the keyring declares.

**(b) Access control — three options, evaluated.**

| Option | Verdict |
| ------ | ------- |
| **(i) Cloudflare Access (Zero Trust)** | **Adopted.** Authentication terminates at the edge, and rate limiting, per-operator identity and an audit trail come with it rather than being written. Cost: it reaches the Pulumi routes stack, and adds one more out-of-band setting |
| **(ii) Dedicated hostname + route separation** | **Adopted alongside (i).** Narrows the surface itself rather than guarding it. Composes with (i) |
| **(iii) `OPERATOR_TOKEN` bearer + constant-time compare** | **Not adopted on its own.** No rate limiting, brute-force resistance is only the secret's length, and it cannot identify *which* operator acted. Kept as the fallback where (i) is unavailable |

**Do not reuse the `DIAGNOSTICS_ENABLED` var gate.** Its containment — deliberately absent from both stage templates, pinned by `wranglerConfig.test.ts` — is what keeps the diagnostic route out of production, and widening it to carry operator entries destroys that.

**(c) Audit log — write it as an allow-list.** Exactly four fields: `entry`, `locator`, `outcome`, and `eventId` for the entries that take one. **Written as "these four and nothing else"**, because an exclusion list silently leaks the next field somebody adds. **The response body is never copied**: not `payload`, not `owner_token`, not `terminal_reason`, not a recipient, not a raw token. The log belongs on the request Worker, which knows who called; a DO-side log can only record what happened and is not an audit trail. The hygiene rules of chapter 9 apply to it in full.

**(d) Which entries are exposed.** The maintenance entries in chapter 10 and nothing else. Business RPCs are not reachable through this path.

**(e) Escalation.** Fail-closed DOs (7.4) and `poison` rows (8.5) escalate through this same path. There is no separate channel for them.

### 8.3 Watching the backlog

> **Reality: None ([#80](https://github.com/tuanemuy/fog/issues/80)).** The entry is not implemented and, when it is, it will still need 8.2 to be reachable. There is no workaround in production; locally, read the DO's SQLite file (chapter 6).

`read-delivery-backlog` — name and contract settled:

- **Reads only.** Writes no row, does not call `rearm()`.
- **Behind the migration gate** (it goes through `enterRpc()`). **On a fail-closed DO this RPC itself answers `SystemError`** — it does not pass through and report zero. That property is what makes the next paragraph work.
- **Returns three values**: `pendingCount`, `publishingCount`, and `oldestCreatedAt` (the minimum `created_at` over `status IN ('pending','publishing')`, or `null`).
- **Does not count `quarantined`.** Those are terminal and have their own listing.
- Returns no `payload`, no `owner_token`, no `aggregate_id`, no `event.id`.

**A fail-closed DO does not present as a growing backlog. It presents as a backlog you cannot read.** The counts come back as an error, not as numbers. To tell the two apart, call `read-schema-version`, which is outside the gate: it answers a version on a fail-closed DO and answers on an uninitialised one too.

### 8.4 The DO side: quarantined events

> **Reality: None ([#80](https://github.com/tuanemuy/fog/issues/80)).** Two of the three entries are implemented in `durableObjectBase.ts` and neither has a caller; the third is not implemented. There is no workaround.

A row reaches `quarantined` when the relay's publish attempts are exhausted (`relayMaxAttempts`, 5). It is terminal, it is **never pruned**, and it only leaves that state by operator action.

**`list-quarantined-events`** — implemented, unreachable.

- Six columns: `event.id`, `type`, `attempt`, `created_at`, `completed_at`, `terminal_reason`. Each omission has its own reason: `owner_token` is a bearer credential for the send-materials guard; `aggregate_id` is the throttle-window key and would correlate messages to one recipient; `payload` is not what explains a quarantine — `terminal_reason` is.
- **Page size 50** (`listQuarantinedEventsLimit`). A cap is required rather than nice to have: quarantine is permanent and happens *en masse* — a failed queue producer binding quarantines everything at once — so an uncapped listing would be the one path in the system that grows with row count.
- **Keyset cursor on `(completed_at, id)`**, ascending by `completed_at`. **Not an offset**: mass quarantine is the case this listing exists for, and operators page through it while re-drives are removing rows underneath, which makes an offset skip whatever shifted down. `outbox_completed_idx` is `(status, completed_at)`, so this order needs no sort; only the `id` tie-break within one `completed_at` does.

**Paging through a mass quarantine.** Take a page, act on every row in it, then request the next page **with the cursor from the page you took, not from the page you would have taken after acting**. Re-driven rows leave the set, so a re-driven page shrinks the remainder rather than shifting it; the keyset cursor stays valid across that. When the cursor comes back `null` the set is drained. If new quarantines are arriving faster than you re-drive, the cause is upstream (see 8.8) and paging will not converge — fix the cause first.

**`requeue-quarantined-event`** — implemented, unreachable.

Writes five columns in one statement: the four state columns — `status = 'pending'`, `next_run_at = now`, `attempt = 0`, `completed_at = NULL` — and a **re-minted `owner_token`**. `terminal_reason` is **kept** — it is the only record of why the row was quarantined. Re-minting the token is the only thing that closes the exposure window: any `(event.id, owner_token)` pair that reached the queue or the DLQ before the quarantine stops passing the send-materials guard. The transaction is followed by a `rearm()`, which is not optional — a DO holding only quarantined rows is by definition disarmed, and that is precisely the situation an operator is re-driving from.

**Try the re-drive before anything else.** It is the only action that closes the token window, and it is safe to run twice.

**`delete-quarantined-event`** — name and contract settled, **not implemented** ([#80](https://github.com/tuanemuy/fog/issues/80)).

- One RPC deletes one row. `WHERE id = ? AND status = 'quarantined'` — two equality conditions, no range, no bulk form.
- Reads the matched row count back and returns `{ deleted: boolean }`.
- **Does not call `rearm()`** — deleting a row adds no runnable work.
- Audited.

**Its scope is narrow on purpose.** A row whose materials have expired does not need deleting: re-drive it, the send-materials RPC answers `nothing-to-send`, the row reaches `published` and prune removes it on schedule. **Explicit deletion is for rows that will not leave `pending` even after a re-drive** — and nothing else. Reaching for it first throws away the token re-minting that the re-drive performs.

### 8.5 The DO side: poisoned jobs

> **Reality: None ([#74](https://github.com/tuanemuy/fog/issues/74) implements all three; [#80](https://github.com/tuanemuy/fog/issues/80) makes them reachable).** None of the three exists. There is no workaround.

A job reaches `poison` when forward progress is exhausted — or, for a row that has a rollback stage, when that rollback ends without completing. **`poison` rows are never pruned**, for the same reason quarantined rows are not: the row is the only record of the residue, and it is the thing a re-drive acts on. Deleting it on a retention timer would leave the residue and remove the record.

**`list-poisoned-jobs`.**

- Five columns: `operation_key`, `kind`, `attempt`, `completed_at`, `terminal_reason`. `payload` is omitted for the same reason as above.
- **Page size 50** and **keyset cursor on `(completed_at, operation_key)`**, ascending by `completed_at` — matching the quarantine listing deliberately, so an operator learns one paging discipline. The tie-break is `operation_key` rather than `id` because `jobs` is keyed on `operation_key` and the five returned columns contain no `id`. `jobs_completed_idx` is `(status, completed_at)`, so the order needs no sort.

**`requeue-poisoned-job`.**

Writes the same four state columns as the quarantine re-drive — `status = 'pending'`, `next_run_at = now`, `attempt = 0`, `completed_at = NULL` — keeps `terminal_reason`, and re-arms. `payload` and `payload_digest` are **not** replaced: this is a re-drive of the same work, not a re-submission of different work.

**Rows whose `terminal_reason` starts with `cleanup-material-lost:` are not re-drive candidates.** That reason means the rollback found its materials already gone; re-driving can never make progress, and doing it in bulk turns a bounded incident into an unbounded loop. Those rows are what explicit deletion is for.

**`delete-poisoned-job`** — name and contract settled, **not implemented**.

- One RPC deletes one row. `WHERE operation_key = ? AND status = 'poison'` — two equality conditions.
- Returns `{ deleted: boolean }`.
- **Does not call `rearm()`.**
- **This is where `cleanup-material-lost:*` rows are disposed of**, after their residue has been dealt with by hand.

### 8.6 The queue side: the DLQ

> **Reality: None.** Not "unimplemented" — **the operations do not exist**.

**The DLQ handler records and discards.** `handleDlqBatch` in `apps/web/app/worker/cloudflare/queueHandlers.ts` logs one line per message and calls `message.ack()` on every one of them, with no `retry()` anywhere; when the batch itself fails, `runQueueBatch` calls `ackAll()` for a DLQ batch. A consumer *is* bound to the DLQ in every config. **So "a message sits in the DLQ" and "re-drive the DLQ" both describe things that do not happen here.**

**What you get is one log line, carrying `event.id` and `type` and nothing else.** That is the whole of what the hygiene rules allow about a queue message, and it is the whole of what survives. **In production, not even that is retained**: no wrangler config in this repository declares an `[observability]` block, so nothing keeps the line past the invocation that wrote it — see 8.7.

**What is lost and what remains when a message reaches the DLQ:**

- **Lost**: that message — one delivery attempt of that event.
- **Remains**: the `published` row in the emitting DO, and the log line.
- **The row cannot be used to recover it.** It is `published`, not `quarantined`, so `requeue-quarantined-event` does not apply to it and there is no DO-side entry that does.

**The typical way a message ends up here is the deploy skew window** described in 4.4 — the deployed consumer cannot route the type or the routing key and burns its retries. The other way is a fail-closed emitting DO (4.3), whose send-materials RPC answers `SystemError` behind the migration gate. In both, the user asking again is the only exit.

**On the queue side an operator gets one log line and nothing else.** Reconsidering that design — retaining messages, using a pull consumer, or dropping the guarantee — is [#83](https://github.com/tuanemuy/fog/issues/83).

Do not raise `message_retention_period` in response to any of this — see chapter 5 for why it buys nothing.

### 8.7 Who may reach the DLQ

**The pair `(event.id, owner_token)` is a bearer credential.** Anyone holding it can call the send-materials RPC and receive the recipient address and the raw reset token, because those two values *are* the guard. Nothing else is checked. A queue message carries both.

Therefore:

- **Restrict who can read the DLQ** to the same people who may reach the operator path (8.2). It is not a lower-sensitivity surface than the maintenance entries; it is the same sensitivity by a different route.
- **Keep no copy of a message.** Not in a ticket, not in a paste, not in an incident channel.
- **The reach control covers the log readers too.** The message itself is acked within seconds and is gone. The log line is written regardless — but **nothing in this repository retains it in production**: none of the six wrangler configs declares an `[observability]` block, so Workers Logs is off, and setting it up is [#22](https://github.com/tuanemuy/fog/issues/22). What is readable in production today is the standard output of a `wrangler tail` session for as long as somebody holds one open, so the reach control applies to whoever that is. The log carries only `event.id` and `type`, which is deliberately not enough to pass the guard on its own, but it is the durable half of a credential and the audience for it should be the operator audience.
- **Never forward the DLQ to an external monitoring or log-aggregation sink.** That prohibition is the price of carrying `owner_token` on the message at all.

### 8.8 Storage pressure

**Monitoring item: `quarantined` and `poison` never shrink on their own.** Everything else the DO stores is self-limiting — `done` and `published` rows are pruned on a retention timer — but these two are permanent by design and leave only by operator action. A delivery outage therefore converts directly into storage growth, and the growth continues until somebody acts.

The cap is 10 GB per Durable Object, counting the base tables and the FTS5 index together. **Near the cap a DO half-dies: writes fail while reads and `DELETE` still succeed.** Every recovery path has to work without a single write, which is why the export and deletion paths are shaped the way they are.

**Identity Directory DOs are shared by many users.** Pressure in one bucket is not one user's problem — it reaches everyone whose credential hashes to that bucket. A single account attracting a flood of quarantined rows can push a whole bucket toward the cap, and the mechanism that bounds it is per-origin rate limiting, which is unimplemented ([#18](https://github.com/tuanemuy/fog/issues/18)).

## 9. Personal data and secrets

### 9.1 Durable Object IDs and routing keys

**A raw email address or an SSO subject is never used as a DO id or a routing key.** DO names are visible in more places than the data inside them — including miniflare's on-disk layout (chapter 6) — and a name is not encrypted.

The two forms in use are:

- **`dir:g{generation}:b{bucket}`** for Identity Directory DOs. Derived from the full-length HMAC of the canonical address under `DIRECTORY_ROUTING_SECRET`, then reduced to a bucket. Many users share a bucket, so the name does not point at a person.
- **The `userId`** for User Data DOs — an opaque generated identifier.

**How to check it:**

```bash
git grep -n "idFromName" -- packages/core/src apps/web/app
```

Every result must pass either a bucket-shaped locator or a `userId`. Nothing derived from an address, a display name, or an SSO subject may reach that call. **In review, treat any new `idFromName` call site as requiring this argument explicitly**; the grep finds the sites but cannot judge what flows into them.

### 9.2 Two prohibitions on queue messages

**(1) Never log a queue message as a whole.** `event.id` and `type` are the most a log line may carry. The rule exists because a message carries `owner_token`, which is half of a bearer credential (8.7).

**(2) Never forward the DLQ to an external monitoring or log-aggregation sink.** No exceptions, no "just the metadata" variant.

**Both are the price of one deliberate exception.** `owner_token` is on the message on purpose — it is the only thing that lets the send-materials guard reject a message the emitting DO no longer recognises. That exception is declared in `spec/async/index.md`; these two prohibitions are what pay for it. Neither may be relaxed without revisiting the exception itself.

**How to check them:**

```bash
# nothing message-shaped may be handed to a logger
git grep -nE "logger\.(debug|info|warn|error)" -- packages/core/src apps/web/app \
  | grep -E "message\.body|\bbody\b|payload|ownerToken|owner_token"
# expected: no output

# who reads a message body at all — the `.` is escaped, or the prose
# "a message body" in the same file matches as a fifth hit
git grep -n "message\.body" -- apps/web/app/worker
# expected: the delivery path destructuring it in handleEventsBatch,
# and otherwise only loggableIdentity(), which projects eventId and type
```

Both are checks on shape, not on intent — a variable holding a body under another name passes them. **The review question is "does anything reaching a logger derive from a message body", and the greps narrow where to look, not whether the answer is no.**

### 9.3 What the guarantee actually covers

**The guarantee is "not logged, not persisted" — it is not "never leaves the Durable Object".**

The recipient address and the raw reset token **do** leave the DO. They cross the boundary as the response of the send-materials RPC that the mail consumer calls at send time, in the request Worker, and are handed straight to the mail provider. What holds is that they are written down nowhere: no column, no log, no queue message, no DLQ, no `terminalReason`.

**This distinction is not pedantry — it is a load-bearing constraint on the consumer.** "It never leaves the DO" would imply the consumer handles nothing sensitive and its logging policy could be relaxed. It handles the most sensitive values in the system. **Do not cite the DO boundary as a reason to loosen logging anywhere on the consumer side.**

### 9.4 Per-origin rate limiting

**Reality: None ([#18](https://github.com/tuanemuy/fog/issues/18)).** Nothing rate-limits by origin today.

What to put in place when it lands, as a WAF rule:

| Aspect | Decision |
| ------ | -------- |
| Paths | the unauthenticated write surfaces: signup, login, password-reset request |
| Key | source IP, plus the submitted address where one is present — **the address is a key input, never a response input** |
| Window | short enough to blunt bursts, long enough not to break a shared NAT; the counter is the WAF's, not the app's |

**The constraint that matters**: the rule must not make a registered address behave differently from an unregistered one. The reset flow goes to considerable trouble to make those two indistinguishable, and a rate limiter keyed on "did this address exist" would hand back the enumeration oracle at the edge.

**This is deliberately not on the pre-deploy checklist.** It is a dashboard-level setting nothing in this repository can observe or verify (chapter 5), and putting an unverifiable item on a mandatory checklist makes the whole checklist unreliable — the first time somebody cannot confirm it, the habit of confirming the rest goes with it. It belongs on the security review, where a human reads the rule.

### 9.5 The dev error overlay is outside the redaction boundary

Vite's development error overlay renders thrown values with full stacks and captured locals, and **nothing redacts it**. `pnpm dev` is therefore not a place to conclude that a secret is not exposed. Non-disclosure is verified by reading the error-response middleware and its tests, not by looking at the screen.

## 10. The maintenance entries, in full

| Entry | Target | Implemented | Reachable | Receives it |
| ----- | ------ | ----------- | --------- | ----------- |
| `read-schema-version` | both classes | **yes** | local only (diagnostic route) | — |
| `list-quarantined-events` | both classes | **yes** | **no** | [#80](https://github.com/tuanemuy/fog/issues/80) |
| `requeue-quarantined-event` | both classes | **yes** | **no** | [#80](https://github.com/tuanemuy/fog/issues/80) |
| `read-delivery-backlog` | both classes | no — **name and contract settled** (8.3) | no | [#80](https://github.com/tuanemuy/fog/issues/80) |
| `delete-quarantined-event` | both classes | no — **name and contract settled** (8.4) | no | [#80](https://github.com/tuanemuy/fog/issues/80) |
| `delete-poisoned-job` | both classes | no — **name and contract settled** (8.5) | no | [#74](https://github.com/tuanemuy/fog/issues/74) |
| `list-poisoned-jobs` | both classes | no | no | [#74](https://github.com/tuanemuy/fog/issues/74) |
| `requeue-poisoned-job` | both classes | no | no | [#74](https://github.com/tuanemuy/fog/issues/74) |
| `purge-user-mappings` | Identity Directory | no | no | [#74](https://github.com/tuanemuy/fog/issues/74) |
| `list-bucket-user-ids` | Identity Directory | no | no | [#74](https://github.com/tuanemuy/fog/issues/74) |
| `rotate-encryption` (start) | Identity Directory | no | no | [#67](https://github.com/tuanemuy/fog/issues/67) |
| `remap-chunk` | Identity Directory | no | no | [#67](https://github.com/tuanemuy/fog/issues/67) ¹ |
| `import-remapped-mappings` | Identity Directory | no | no | [#67](https://github.com/tuanemuy/fog/issues/67) ¹ |
| `record-remapped-locator` | **User Data** | no | no | [#67](https://github.com/tuanemuy/fog/issues/67) ¹ |
| `read-rotation-checkpoint` | Identity Directory | no | no | [#67](https://github.com/tuanemuy/fog/issues/67) ¹ |

¹ The four rotation entries are listed here for completeness only. **Their operational substance — pre-execution approval and audit format, chunk sizing, the deploy ordering of the two rotations, the ordering to use when both keys leak at once, and notifying users that links to the old bucket die — is written by [#67](https://github.com/tuanemuy/fog/issues/67), not here.** The one piece of rotation operations that stays in this document is the PITR interaction in 11.3 (c), because it is a step of the PITR procedure and leaving it out would make a leaked key look retired when it is not.

**Three entries have a settled name and contract with no implementation**: `read-delivery-backlog`, `delete-quarantined-event`, `delete-poisoned-job`.

**Reach control for every row above is the design in 8.2.** No entry gets its own.

**`cancel-reservation` is not on this list and is not an operator entry.** It requires a `callerToken`, and the only path that returns that value needs the user's own valid session — so an operator cannot execute it. Its callers are the automatic rollback stages (the coordinator bucket and the User Data DO). **The operator's entry into a terminated saga is `requeue-poisoned-job`.**

**Entries that only read do not re-arm the Alarm**: `read-schema-version`, `list-bucket-user-ids`, `list-quarantined-events`, `list-poisoned-jobs`, `read-rotation-checkpoint`, `read-delivery-backlog`. The two deletion entries do not either — removing a row adds no runnable work. Everything that writes a runnable row re-arms.

## 11. Data lifecycle

### 11.1 Per-user export

**Reality: None ([#15](https://github.com/tuanemuy/fog/issues/15)).**

All of a user's data is inside one Durable Object, so an export is one `transactionSync` in one place — no cross-object join, no consistency problem. **The read is not split**, because splitting it would lose the snapshot's consistency.

Not splitting means the size has to be bounded instead. **The derivation rule is settled; the number is not:**

> The cap is the largest total byte count that can be read out in one `transactionSync` and then rendered and zipped in the request Worker within its CPU budget — whichever of the two binds first. Reading is bounded by the DO's per-query result-set ceiling; rendering and zipping are bounded by the Worker's CPU time. Exceeding the cap is rejected with a `SystemError`; no partial archive is ever produced.

**Fixing the number belongs to [#15](https://github.com/tuanemuy/fog/issues/15)**, which is also where the export feature itself lands. It cannot be derived today because neither side of the "whichever binds first" has an implementation to measure.

**Export is not a backup.** It excludes the trash and returns only current revisions, so it cannot stand in for PITR.

### 11.2 Withdrawal and complete deletion

**Reality: None ([#74](https://github.com/tuanemuy/fog/issues/74)).**

Two objects hold a user, and they are deleted in one order:

1. **User Data DO** — all domain data and the FTS5 index. Deleting the object deletes the storage.
2. **Identity Directory bucket** — the user's `credential_mappings` rows. **The bucket is shared, so it is not deleted; rows are.**

The `finalize-withdrawal` saga coordinates this. Partial failure is normal and is handled by the saga's own retry and rollback, not by an operator. What an operator sees when it cannot converge is a `poison` row (8.5), and the first response is `requeue-poisoned-job`.

**`purge-user-mappings` is the last resort**, for when the saga cannot converge because the mapping rows themselves are the obstruction. It deletes residue directly and is the only entry that does; treat it as a manual override with no undo, run it after `requeue-poisoned-job` has been tried, and audit it.

**Withdrawal only becomes irreversible once the PITR retention window has passed** — until then, restoring both the User Data DO and its bucket would bring the account back. That is why PITR against a withdrawn account is forbidden (11.3 (d)).

### 11.3 Point-in-time recovery

**Reality: None ([#81](https://github.com/tuanemuy/fog/issues/81)) for the mandatory steps**, and the four are blocked for two different reasons. **Two of them have no storage to act on**: `ai_client_connections` is not a table anywhere in the tree, and `password_reset_tokens` belongs to [#12](https://github.com/tuanemuy/fog/issues/12). **The other two have their storage and no way to reach it**: `account.session_epoch` and `credential_mappings.failed_attempts` / `next_attempt_allowed_at` are columns of v1 schemas that exist today, and what is missing is an operator path that writes them ([#80](https://github.com/tuanemuy/fog/issues/80)). **Running a restore today would leave revoked sessions, revoked connections and consumed reset tokens alive with no way to clear them** — but only half of that is a schema problem.

- **Retention: 30 days**, per Durable Object.
- **The unit of recovery is one DO.** There is no way to restore several objects to a common instant.
- **PITR finds nothing.** A DO's internal id does not map back to a `userId`, so the blast radius of an incident can only be built by sweeping a bucket (`list-bucket-user-ids`, then `read-schema-version` one at a time) — both of which are unimplemented. **It is a way to recover a target you already know, not a way to find one.**

**Mandatory steps — all four, every time:**

| # | Object | Step | Why |
| - | ------ | ---- | --- |
| 1 | User Data DO — the `account.session_epoch` **column**, which exists | advance it to a monotonic value derived from the current time | restoring rolls it back and revoked sessions become valid again |
| 2 | User Data DO — the `ai_client_connections` **table**, which does not exist | set every row to `revoked` | same — revoked connections come back alive |
| 3 | Identity Directory bucket — the `password_reset_tokens` **table**, which does not exist ([#12](https://github.com/tuanemuy/fog/issues/12)) | delete every row | consumed and deleted reset tokens reappear |
| 4 | Identity Directory bucket — the `credential_mappings.failed_attempts` and `.next_attempt_allowed_at` **columns**, which exist | set the first to 0 and clear the second | the restore may reinstate a lockout the user has already served |

**The default is to cut everything.** If a step cannot be completed, revoke rather than leave it.

**PITR also rolls back delivery.** `outbox_events` rows return from `published` to `pending` and the relay publishes them again. At-least-once means that is not a correctness problem, but **what reaches the user depends on the order against the steps above:**

- Steps **first**, then let the Alarm fire → the re-delivered events find no token row and every one answers `nothing-to-send`. Duplicated delivery, nothing sent. **This is the correct order.**
- Alarm **first** → the same reset link is emailed again. That is the window the ordering exists to close.

**`owner_token` rolls back too.** It is not nulled at termination, so a `(event.id, owner_token)` pair that was already in the queue or the DLQ before the restore can pass the send-materials guard again. Closing that window means re-driving through `requeue-quarantined-event`, which re-mints the token (8.4).

**Four further points the specs leave to operations:**

**(a) Approving and auditing the restore itself.** A PITR is destructive to everything written after the restore point, and it is unobservable afterwards — nothing in the object records that it happened. So: **two people, one executing and one approving, with the approval recorded before execution.** The audit record uses the same allow-list discipline as 8.2 (c) — write down what is permitted, never a copy of a response body:

| Field | Content |
| ----- | ------- |
| target | the DO class and locator |
| restore point | the timestamp restored to |
| reason | the incident reference |
| approver | who approved, and when |
| operator | who executed, and when |
| mandatory steps | which of the four ran, and their outcome |

This is the ordinary procedure for a permitted restore. The withdrawn-account case in (d) is a ban with its own exception, approved on stricter terms.

**(b) `reset_request_windows` rolls back as well, and its effect does not depend on ordering.** Restoring returns the throttle windows to a past state, so `claimWindow` answers `true` again for a window that had already been consumed. The consequence is a fresh reset token issued — **which replaces every unused token, killing the link already in the user's hands** — plus a second email. Steps 1–4 do not prevent this: it fires whether they ran before or after. **Reality: none — the table is unimplemented ([#12](https://github.com/tuanemuy/fog/issues/12))**, so there is nothing to clear today and nothing to roll back; when it lands, clearing it belongs with the four steps.

**(c) A restored bucket's rotation checkpoint is void.** A checkpoint asserting `previousCount = 0` is permanently true only because no path can write rows into a previous generation — and **PITR is outside that argument**, since it restores rows that were deleted. So: **treat any checkpoint on a restored bucket as invalid, re-drive the transfer for that bucket, and only then judge retirement.** Re-read the checkpoints immediately before the retirement deploy, as part of the same procedure. Skipping this retires a key whose old-generation rows are still readable.

**(d) PITR against a withdrawn account is forbidden.** Restoring the User Data DO and the bucket's `credential_mappings` rows together brings the account back, which is precisely why a withdrawal is not irreversible until the retention window has passed (11.2). The ban is what stops that window from being used to undo a completed withdrawal.

An exception is possible — a withdrawal executed against the wrong account, or one the owner did not ask for — and it is approved on stricter terms than the ordinary restore in (a):

- **What is approved in addition.** (a) approves a restore. (d) approves a restore **and**, as a separate decision recorded separately, the reversal of a completed withdrawal. The second decision names the account being brought back and the evidence that the withdrawal was not what its owner asked for.
- **Who may approve.** (a) accepts any second person. (d) does not accept the operator who executed the withdrawal in either role, and the approver has to be someone acting on the account owner's own request rather than on an operator's account of it.
- **The window closes by itself, and closing is one-way.** Once the 30-day retention window passes there is nothing left to restore, and the withdrawal becomes irreversible with no further action by anyone. **An exception therefore has to be decided inside the window; deferring the decision is the same as denying it.**

The audit record is the one in (a), with the withdrawal-reversal decision written into its `reason` and `approver` rows.

## 12. Operating values

Every field of `DELIVERY_TUNING_DEFAULTS` (`packages/core/src/application/delivery/tuning.ts`) and `IDENTITY_TUNING_DEFAULTS` (`packages/core/src/application/identity/tuning.ts`), with what fixes it.

**Those two declarations are the source of truth; the tables below are a copy of them.** The limit that comes with the copy: **nothing compares the two mechanically.** Move a value in `tuning.ts` and this chapter goes stale in silence, so moving one means moving the other in the same change. The exceptions are the five declarations the queue consumers carry — `eventsMaxRetries`, `dlqMaxRetries`, `eventsMaxBatchTimeoutMs` and `eventsRetryDelayMs` against every request-Worker config, and `dlqRetentionMs` against the deploy templates' headers — and even there the test (`wranglerConfig.test.ts`) pins each declaration against `wrangler.toml` and the `.tpl` files, not against this document.

**These are settled, and four forms of reason recur — neither exhaustive nor disjoint** — a platform ceiling, a constraint `createDeliveryTuning` checks at construction, the one measurement recorded on [#37](https://github.com/tuanemuy/fog/issues/37), and a copy of a value the wrangler config states. **A value that matches none of the four is a judgement made against the shape the machinery requires, and not a derivation**; the "What fixes it" column says which, one row at a time, and a row that gives a reason rather than a source is one of those judgements.

**No value here comes from a spike on a real workload, and none can today**: **no `jobs.kind` handler is registered yet**, so there is nothing whose per-wake-up cost could be timed. That is the trigger — **the spike runs once the first handler lands** (tracked on [#12](https://github.com/tuanemuy/fog/issues/12); [#74](https://github.com/tuanemuy/fog/issues/74) would satisfy it too), and **tiers 1 and 2 of the three-tier job bound are what to revisit** then; tier 3 is the bind ceiling and moves only with SQLite.

### 12.1 Delivery

| Field | Value | What fixes it |
| ----- | ----- | ------------- |
| `relayMaxRowsPerPass` | 25 | **a network bound, not a CPU one.** The relay publishes row by row with `send()` and never `sendBatch`, so this caps the round trips one pass makes, and it is held independently of the three job limits for that reason. **Its numeric agreement with the consumer's `max_batch_size` is a coincidence of choosing the same number, not a derivation** — a consumer batch size constrains what one consumer invocation receives and bounds nothing a producer claims |
| `relayLeaseMs` | 60,000 | comfortably longer than one publish round trip, short enough that a DO reset is recovered within a minute |
| `relayBackoffBaseMs` | 1,000 | one second is below the noise floor of a transient publish failure |
| `relayBackoffMaxDelayMs` | 300,000 | the cap, and **it never binds at `relayMaxAttempts` = 5** — from a 1 s base the delay reaches 300,000 ms only at attempt 9. It is there to bound the curve if the attempt count is ever raised |
| `relayMaxAttempts` | 5 | the delays actually taken are 2 s, 4 s, 8 s, 16 s, so a row reaches quarantine **≈ 30 s** after its first failed publish. Counted as the whole curve from attempt 0 — `1 + 2 + 4 + 8 + 16` — the run is 31 s. `createIdentityTuning` sums a curve of exactly this form, but it sums the **jobs** one; see 12.2 |
| `jobsMaxJobsPerPass` | 10 | tier 1 of the three-tier bound. **Derived, not measured**: 10 jobs × tier 2's 2,000 rows = 20,000 rows per wake-up ≈ 70 ms at the rate below, which sits well inside a Worker's CPU budget |
| `jobsMaxChunkIterations` | 20 | tier 2. **Derived, not measured**: 20 iterations × tier 3's 100 rows = 2,000 rows per job ≈ 7 ms, taken from the 3.4 ms per 1,000 rows measured during the move to Durable Objects ([#37](https://github.com/tuanemuy/fog/issues/37)) |
| `jobsMaxRowsPerChunk` | 100 | tier 3 — SQLite's 100-bind ceiling per statement. **A statement spending more than one bind per row divides this**: two columns per row means 50 rows, not 100 |
| `jobsLeaseMs` | 60,000 | same reasoning as the relay lease |
| `jobsBackoffBaseMs` | 1,000 | same |
| `jobsBackoffMaxDelayMs` | 300,000 | same — a cap that does not bind at five attempts |
| `jobsMaxAttempts` | 5 | same — 2 s, 4 s, 8 s, 16 s, so ≈ 30 s before the row turns `poison` (or enters its rollback stage) |
| `failClosedRearmIntervalMs` | 300,000 | fixed interval, **no backoff** — the cause is deployment state and the DO must keep checking at a steady rate |
| `publishedRetentionMs` | 86,400,000 | 24 h. Participates in constraint 2 (12.3), which only requires it to reach 900,000 — a 96× margin, so the constraint does not fix the value |
| `doneRetentionMs` | 86,400,000 | matched to `publishedRetentionMs`; two retentions that differ would need a reason |
| `pruneMaxRowsPerPass` | 50 | a judgement about how much one pass may delete inside a single transaction. **The bind ceiling does not apply here**: the `DELETE … WHERE key IN (SELECT … LIMIT ?)` form spends three binds whatever the row count |
| `eventsMaxRetries` | 3 | mirrors the events consumer's `max_retries` |
| `dlqMaxRetries` | 1 | mirrors the DLQ consumer's `max_retries`; the DLQ has no DLQ, so a retry is one redelivery then permanent discard |
| `eventsMaxBatchTimeoutMs` | 30,000 | mirrors `max_batch_timeout` |
| `eventsRetryDelayMs` | 0 | the config leaves `retry_delay` unset; a config that starts setting it moves this with it |
| `dlqRetentionMs` | 600,000 | the counterpart of the out-of-band `--message-retention-period-secs 600`. **The two are pinned to each other and neither fixes the value** — `wranglerConfig.test.ts` compares the template headers' seconds against this declaration, so ten minutes is a judgement. **Bounds undelivered backlog, not DLQ dwell time** (chapter 5) |
| `queueMaxRetryPeriodMs` | 300,000 | a budget, not a setting — floor is 90,000 (`3 × (0 + 30,000)`), checked at construction. **That 90,000 is recomputed from `eventsMaxRetries`, `eventsRetryDelayMs` and `eventsMaxBatchTimeoutMs`, and `delivery/__tests__/tuning.test.ts` pins it from both sides**, so moving any of the three turns the suite red. What is not pinned is this table's copy of the number, which the chapter preamble's "nothing compares the two mechanically" already covers |
| `resetTokenTtlMs` | 3,600,000 | 1 h. Bounds constraint 1 (12.3), which only requires it to exceed 900,000 — a 4× margin, so the constraint does not fix the value |
| `queueMaxBatchCount` | 100 | a constant of miniflare's queues broker (`MAX_MESSAGE_BATCH_COUNT`). **Unverified against the production Queue** |
| `queueMaxBatchBytes` | 288,000 | the same broker's `MAX_MESSAGE_BATCH_SIZE`. **Unverified against the production Queue** |
| `queueMaxMessageBytes` | 128,000 | the same broker's `MAX_MESSAGE_SIZE_BYTES`, **unverified against the production Queue**; the only one of the three that can bite today, since the relay publishes row by row |
| `listQuarantinedEventsLimit` | 50 | page size for the quarantine and `poison` listings; keyset continuation (8.4) |

### 12.2 Identity

| Field | Value | What fixes it |
| ----- | ----- | ------------- |
| `reservationTtlMs` | 3,600,000 | **bounded below, not derived** — it has to exceed two runs of the **job** backoff curve (forward progress, then the rollback that reads the reservation for its material), which `createIdentityTuning` sums into a floor of **62,000 ms** and rejects a value at or below. The relay curve carries the same three numbers today, so the two runs look alike; moving `jobsMaxAttempts` moves the floor and moving `relayMaxAttempts` does not. **The check is cleared 58× over, so it does not fix the value** |
| `loginLockoutThreshold` | 5 | failures tolerated before any lockout; the failure at this count still leaves the next attempt immediate |
| `loginLockoutBaseMs` | 30,000 | first lockout past the threshold, doubling thereafter |
| `loginLockoutMaxMs` | 900,000 | **abuse rule (i), the ceiling** — an attacker throwing wrong passwords at a known address cannot push the owner's next attempt out indefinitely |
| `loginAttemptDecayMs` | 900,000 | **abuse rule (ii), the decay** — one failure is forgiven per elapsed span, so success is not the only way back to zero |

The four lockout values are chosen against the shape the domain requires, not against measured attacker behaviour. **What would move them is field data on real login traffic, which does not exist.**

### 12.3 The two delivery constraints

**There are exactly two, and that is all of them.** Both share the left-hand side `queueMaxRetryPeriodMs + dlqRetentionMs`; only the bound differs.

1. `< resetTokenTtlMs` — **a functional requirement**: what has to hold is that the **last events-queue retry** still finds the token live, that retry being the last attempt carrying the link at all. The left-hand side is a conservative stand-in for that window — its second term is the worst-case age a message can reach on its way to the DLQ handler, margin added on top rather than time a delivery spends, and **the DLQ leg carries no delivery** (8.6).
2. `<= publishedRetentionMs` — the send-materials guard requires the row to exist, so a delivery arriving after prune removed it always misses.

`createDeliveryTuning` enforces both, plus the floor on `queueMaxRetryPeriodMs`. Writing only one lets the value-setter pick two numbers that cannot both hold, and the resulting permanent miss is close to undetectable in operation.

**The throttle window's constraint is a third value, and it is outside this pair.** The enumeration above is a closed statement about *delivery* operating values; the window's inequality is a different one, and it lives in 12.4.

### 12.4 Values with no reader yet

| Value | Where it goes | Receives it |
| ----- | ------------- | ----------- |
| **Throttle window length**, and the grace added to a window row's `expires_at` | `IdentityTuning` in `packages/core/src/application/identity/tuning.ts`, as `resetRequestWindowMs` and `resetRequestWindowGraceMs` | [#12](https://github.com/tuanemuy/fog/issues/12) |
| **Export total-byte cap** | the export tuning the feature introduces; the derivation rule is in 11.1 | [#15](https://github.com/tuanemuy/fog/issues/15) |
| **Per-origin rate limit** (paths, key, window) | a WAF rule, not this repository; see 9.4 | [#18](https://github.com/tuanemuy/fog/issues/18) |

**On the throttle window: one configured value, read by two layers.** The usecase reads it to compose `windowKey` (the HMAC combined with the window), and the adapter reads it to compute the window row's `expires_at` (window end **plus a grace**). **Do not place two constants.** If the adapter's is shorter, `sweep-reset-tokens` deletes a window row that is still live, `claimWindow` answers `true` a second time inside the same window, **and the user's existing link dies while a second email goes out**. The single root is the DI container: both the usecase and the adapter that writes the row take the value from the same container.

**Settled values, pending a reader:** window length **900,000 ms** (15 minutes), grace **300,000 ms** (5 minutes) on top of it. The grace exists so that clock skew between the composing layer and the sweeping layer cannot delete a window that is still being counted against.

**The window length carries one inequality — the third value named in 12.3, not a third delivery constraint.** `spec/database/index.md` requires the **window length to be strictly below `resetTokenTtlMs`**; break it and a user whose link has expired gets no resend until the window opens, which collides with the reset flow's own "the link expired, send another" path. The settled pair satisfies it — 900,000 < 3,600,000. **Its limit is that nothing checks the arithmetic**: `createIdentityTuning` validates every field it holds and the window is not one of them, so the inequality is held by a reader of this document until [#12](https://github.com/tuanemuy/fog/issues/12) lands the field, at which point it becomes a construction-time check alongside the others.

### 12.5 What the count limits do not bound

The per-pass limits cap **how many rows are taken from the result**, not how much work produced it.

The claim `SELECT` reads the due part of the runnable set and sorts it:

- **Scanning is proportional to "runnable ∧ due".** The statement spells the leased status as a literal, so it satisfies `*_runnable_idx`'s partial predicate syntactically and the planner seeks that index with `next_run_at` as an index constraint rather than a residual filter. A bind parameter there proves nothing about the value it will hold, which is why the literal is load-bearing — put a bind back and the plan falls to `*_completed_idx`, silently, with the same rows returned.
- **Sorting is over "runnable ∧ due"** as well, which the count limit does not restrict — the limit applies after the sort, to the rows taken.
- **Neither is bounded by `jobsMaxJobsPerPass` or `relayMaxRowsPerPass`.**
- **The Alarm's re-arm being a set of index seeks does not change this.** The re-arm and the claim are different statements: the re-arm costs four seeks, and the claim stays proportional to "runnable ∧ due". **One wake-up is not independent of backlog size.**

The sort is accepted deliberately: ordering by `next_run_at` is what stops rows left behind by a DO reset from starving behind a steady supply of `pending` rows. The trade is the opposite of the Alarm's, where decomposition avoided a sort.

**The index is `jobs_runnable_idx` / `outbox_runnable_idx`.** The name can be written here because something turns red when it stops being true: the `EXPLAIN QUERY PLAN` assertion in `packages/core/src/adapters/cloudflare/__tests__/rowRunner.integration.test.ts`, which measures the statement the module itself issues and asserts both the index name and that `next_run_at` is an index constraint.

**Two limits on that.** The plan is SQLite's, so the choice can change if the version workerd bundles does — the same assertion is what would report it. And the assertion measures an **empty DO with no `sqlite_stat1`**, so the plan under gathered statistics is not measured; nothing in this repository runs `ANALYZE`, which is what keeps the measured plan the one that runs.

### 12.6 The per-query result-set ceiling

**A Durable Object caps the total size of one query's result set.** The value comes from Cloudflare's published limits, is **not measurable from this repository**, and **no design here depends on it today** — the export path, which is the one thing that would, is unimplemented (11.1).

### 12.7 Measured: occupancy of a shared bucket

**One `getResetMailMaterials` call**, which is the RPC a shared Identity Directory bucket serves on the delivery path.

| | |
| --- | --- |
| **Measured** | mean **0.68 ms** per call over 500 consecutive warm calls (total 342 ms); p50 and p95 both at the 1 ms measurement floor; slowest warm call 8 ms; first (cold) call 8 ms |
| **Conditions** | miniflare / workerd under `vitest.config.do.ts`, local machine, in-memory DO. One Identity Directory bucket seeded with 520 `published` rows; timed from the caller across the RPC boundary, so the figure includes the stub hop. Material source stubbed to return a live address, i.e. the `send` branch including the HMAC derivation |
| **Date** | 2026-08-24 |

**Limit — the per-call figures are at the instrument's floor.** workerd clamps timer resolution to 1 ms and advances clocks only at I/O boundaries, so p50 and p95 are the smallest observable value rather than measurements. **Only the aggregate is meaningful**, because it spans many I/O boundaries. This is a local, in-memory measurement and says nothing about production, where storage is real and the object is shared with concurrent callers.

**This is recorded as material, and no judgement is drawn from it.** [#58](https://github.com/tuanemuy/fog/issues/58) closed by settling the revisit condition it was about, and that condition now lives in `spec/async/index.md` (P-001), whose "RPC round-trip cost" axis names exactly this kind of measurement as its material. **Applying the figure to that axis is still out of scope here** — the judgement belongs to whoever next revisits P-001.

## 13. What manual testing needs, and what exists

Enumerated from **every file under `spec/manual-tests/`** — `index.md`, `account.md`, `ai.md`, `document.md`, `search.md`, `settings.md`, `timeline.md`, `trash.md` — with duplicates folded across files. The list below is the union; it is not the delivery-focused subset that `account.md` alone would give.

| # | Capability | Required by | Reality |
| - | ---------- | ----------- | ------- |
| 1 | Seed memos with past posting dates directly into a DO | `timeline.md` (TC-03/07/08/24/25), `settings.md` (TC-03) | **None ([#82](https://github.com/tuanemuy/fog/issues/82))** |
| 2 | Seed trash rows whose `purge_after` is in the past | `trash.md` (TC-13/23/24) | **None ([#82](https://github.com/tuanemuy/fog/issues/82))** |
| 3 | A development write RPC (the stated alternative to 1 and 2) | `timeline.md`, `settings.md` | **None ([#82](https://github.com/tuanemuy/fog/issues/82))** |
| 4 | Move the clock backwards, or equivalent | `trash.md` (TC-13/24) | **None ([#82](https://github.com/tuanemuy/fog/issues/82))** |
| 5 | Fire `purge-trash` without waiting for the Alarm | `trash.md` (TC-13/24) | **None ([#82](https://github.com/tuanemuy/fog/issues/82))** |
| 6 | Fast-forward DO-side backoff / retry | `account.md` (TC-45/47) | **None ([#82](https://github.com/tuanemuy/fog/issues/82))** |
| 7 | Shorten the time the queue takes to burn its retries | `account.md` (TC-46) | **Local only** — edit `max_retries` in `wrangler.toml` and the matching declared value, then restart |
| 8 | Observe the Outbox backlog | `account.md` (TC-44) | **None ([#80](https://github.com/tuanemuy/fog/issues/80))** — `read-delivery-backlog` is unimplemented |
| 9 | `list-quarantined-events` | `account.md` (TC-45) | **None ([#80](https://github.com/tuanemuy/fog/issues/80))** — implemented, no caller |
| 10 | `requeue-quarantined-event` | `account.md` (TC-45) | **None ([#80](https://github.com/tuanemuy/fog/issues/80))** — implemented, no caller |
| 11 | `list-poisoned-jobs` | `account.md` (TC-47) | **None ([#74](https://github.com/tuanemuy/fog/issues/74))** |
| 12 | `requeue-poisoned-job` | `account.md` (TC-47) | **None ([#74](https://github.com/tuanemuy/fog/issues/74))** |
| 13 | Observe terminal mode (`status` runnable **and** `terminal_reason` set) | `account.md` (TC-47) | **None ([#74](https://github.com/tuanemuy/fog/issues/74))** |
| 14 | Confirm a `poison` row survives the retention window | `account.md` (TC-47) | **None ([#74](https://github.com/tuanemuy/fog/issues/74))** — same reader as 11/13 |
| 15 | `read-schema-version`, to separate fail-closed from a real backlog | `account.md` (TC-44) | **Local only** — the diagnostic route (chapter 6) |
| 16 | List the DLQ's messages and read one | `account.md` (TC-46) | **None ([#83](https://github.com/tuanemuy/fog/issues/83))** — messages are acked and gone (8.6) |
| 17 | Re-drive from the DLQ | `account.md` (TC-46) | **None ([#83](https://github.com/tuanemuy/fog/issues/83))** — **the operation does not exist** |
| 18 | Break and restore the queue producer binding, to force quarantine | `account.md` (TC-45) | **Local only** — comment out `[[queues.producers]]` in `wrangler.state.toml` and restart |
| 19 | Break and restore the mail provider, to force a DLQ landing | `account.md` (TC-46) | **None ([#12](https://github.com/tuanemuy/fog/issues/12))** — the only `MailSender` is the console adapter, which always succeeds |
| 20 | Open a throttle window (clear `reset_request_windows`) | `account.md` (TC-44/45/46) | **None ([#12](https://github.com/tuanemuy/fog/issues/12))** — the table does not exist |
| 21 | Fail a cross-DO RPC for one specific bucket | `account.md` (TC-47) | **Local only, and too coarse** — breaking `script_name` disables *all* DO calls, not one bucket |
| 22 | Receive mail (a development mailbox) | `account.md` (many), `timeline.md` | **None ([#12](https://github.com/tuanemuy/fog/issues/12))** — nothing is sent, and the console adapter deliberately logs neither recipient nor token |
| 23 | Shorten the reset-token TTL | `account.md` (TC-30) | **Local only** — edit `resetTokenTtlMs`; there is no env override. **Editing it alone floors at 900,001 ms**, because constraint 1 (12.3) is checked at construction against `queueMaxRetryPeriodMs + dlqRetentionMs`; lowering those two as well — to 90,000 (their own floor) and 0 — takes the TTL down to 90,001 ms. Below that `createDeliveryTuning` throws `CONFIGURATION_ERROR` and the container never builds |
| 24 | Produce an expired authorization URL | `account.md` (TC-25) | **None ([#13](https://github.com/tuanemuy/fog/issues/13))** |
| 25 | Read and adjust the lockout settings | `account.md` (TC-40) | **Local only** — edit `IDENTITY_TUNING_DEFAULTS`; there is no env override |
| 26 | A real MCP-capable AI client connected to the app | `ai.md` (all), `account.md`, `timeline.md`, `document.md` | **None ([#13](https://github.com/tuanemuy/fog/issues/13) / [#14](https://github.com/tuanemuy/fog/issues/14))** |
| 27 | Call the REST API directly with `curl` under an AI token | `ai.md` | **None ([#14](https://github.com/tuanemuy/fog/issues/14))** |
| 28 | Read the AI client's tool-execution log | `ai.md` | **None ([#13](https://github.com/tuanemuy/fog/issues/13) / [#14](https://github.com/tuanemuy/fog/issues/14))** |
| 29 | Two real Google accounts and a registered OAuth client | `account.md` (SSO cases) | **None ([#12](https://github.com/tuanemuy/fog/issues/12))** |
| 30 | A Google account sharing an address with a password account | `account.md` (TC-18) | **None ([#12](https://github.com/tuanemuy/fog/issues/12))** |
| 31 | A second browser session (private window / second browser) | `account.md`, `timeline.md`, `document.md`, `trash.md`, `search.md`, `settings.md` | **Available** |
| 32 | Throttle the network from devtools (Offline / Slow 3G) | `timeline.md` (TC-17/18) | **Available** |
| 33 | Bulk-post 51+ memos | `timeline.md` (TC-04), `search.md` (TC-22) | **None ([#2](https://github.com/tuanemuy/fog/issues/2))** — memo posting is unimplemented |
| 34 | Generate long text locally and save it to a file | `timeline.md`, `document.md`, `ai.md`, `search.md` | **Available** |
| 35 | Unzip an archive and inspect it with `find` / `grep` | `settings.md` (TC-03/04/05/06/11) | **Available** as a technique; **there is no archive to inspect** until [#15](https://github.com/tuanemuy/fog/issues/15) |
| 36 | Set the browser timezone to `Asia/Tokyo` | `settings.md` | **Available** |
| 37 | A second, empty user account | `settings.md`, `timeline.md`, `document.md`, `trash.md` | **Available** — sign-up works |
| 38 | Run SQL against a database shared by all users | `timeline.md` names it as *not existing* | **None, by design** — every user's data is inside their own DO. `db:execute:<stage>` reaches D1, which holds no business data |

**Three things about running these tests that are easy to get wrong:**

- **There is no shared database to reach for** (row 38). Data is per-DO by construction. `wrangler d1 execute` succeeds and touches nothing that matters.
- **Fast-forwarding the DO does not advance the queue** (rows 6 and 7 are different capabilities). The queue's redelivery interval and `max_retries` are platform settings; no amount of poking the Alarm moves them. Observing a retry burn-through needs a separate queue configured with a smaller `max_retries`.
- **Delivery is asynchronous and at-least-once.** Expect to wait, and expect the same email more than once. **A duplicate is not a bug** — a test that fails on the second copy is testing the wrong thing.

## 14. Known limits and where they are tracked

| Limit | Tracked in |
| ----- | ---------- |
| The request Worker cannot be deployed, and `pnpm start` does not boot | [#73](https://github.com/tuanemuy/fog/issues/73) |
| D1 remains as a binding, a config block and migration scripts with no runtime reader; the per-stage D1 script names do not match what Pulumi creates | [#79](https://github.com/tuanemuy/fog/issues/79) |
| No operator path exists — two implemented maintenance RPCs have no caller, and two more are unimplemented | [#80](https://github.com/tuanemuy/fog/issues/80) |
| The `poison` operator path (list / requeue / delete) does not exist | [#74](https://github.com/tuanemuy/fog/issues/74) |
| **Re-driving the DLQ does not exist** — the handler acks every message | [#83](https://github.com/tuanemuy/fog/issues/83) |
| **The DLQ's one log line is not retained in production** — no wrangler config declares `[observability]`, so Workers Logs is off and only a live `wrangler tail` sees it | [#22](https://github.com/tuanemuy/fog/issues/22) |
| PITR's mandatory steps cannot be executed — two of the four have no storage, and two have storage with no operator path to it | [#81](https://github.com/tuanemuy/fog/issues/81) |
| Manual testing has no seeding, no forced Alarm, no backoff fast-forward | [#82](https://github.com/tuanemuy/fog/issues/82) |
| Stuck delivery is not actively notified | [#23](https://github.com/tuanemuy/fog/issues/23) |
| No per-origin rate limiting | [#18](https://github.com/tuanemuy/fog/issues/18) |
| **Fail-closed DOs cannot be found across the fleet** — DOs cannot be enumerated, `list-bucket-user-ids` is unimplemented, and the diagnostic route does not exist in production | [#74](https://github.com/tuanemuy/fog/issues/74) (the entry) / [#22](https://github.com/tuanemuy/fog/issues/22) (observability) |
| **Individual operators cannot be told apart.** Nothing today identifies who performed an action; option (iii) in 8.2 could not fix this even if adopted, which is why (i) is | [#80](https://github.com/tuanemuy/fog/issues/80) |
| The three out-of-band settings (DLQ retention, queue retry period, WAF) cannot be read back from the repository | chapter 5 — inherent, not scheduled |
