# Runtime: Cloudflare

The operational runbook for the reference runtime: what is deployed, what an operator can reach, and what they cannot.

## How to read this document

Every section that describes a procedure carries a **Reality** marker, and the marker answers one question only: **can this be run against production today?**

| Marker | Meaning |
| ------ | ------- |
| **Available** | Runnable against production today. |
| **Local only** | Runnable under `pnpm dev` / `pnpm preview`; there is no way to do it in production. |
| **None (#N)** | Runnable in neither; the issue #N tracks the limit. A **None** with no number is so by design, and says why. |

Two rules follow from that question, and both are easy to get wrong:

- **The marker is not decided by whether code exists.** A maintenance RPC is **Available** because `POST /__operator/<entry>` (8.2) reaches it, not because its method is defined on the Durable Object; a capability that only `sqlite3` against `.wrangler/state` provides is **Local only** however complete the code behind it is.
- **The marker is not lowered because a later step is blocked.** `wrangler secret put`, `wrangler queues update` and `pulumi up` are commands you can run today, so they are **Available** even though the deploy they prepare for stops at the request Worker's bundling (4.2, tracked in [#3](https://github.com/tuanemuy/fog/issues/3)). Where that boundary falls is shown by section headings — "before the deploy" versus "after the deploy" — not by the marker.

**A section whose reality is `None` still carries its full procedure, and says so at the top.** The alternative — leaving it out — reads as "there is a way and we did not write it down".

**This document records what is, not the gap between what is and what a spec says.** A limit is tracked on an issue; this document carries the fact and the issue number, never the plan to close it. Where a behaviour is a limit of the implementation rather than a gap — something the code does on purpose and the spec does not name — it is written as a limit, in the section it belongs to.

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

**D1 is not in the runtime.** No wrangler config declares a `d1_databases` binding, there is no `packages/core/src/adapters/d1/`, no Drizzle, and no Vitest project for it — every piece of user data lives in that user's Durable Object. What remains is outside the runtime: the Pulumi `resources` stack still provisions a protected D1 database, and `apps/web/scripts/render-wrangler.ts` still substitutes `D1_DATABASE_ID` / `D1_DATABASE_NAME`, which no template uses. Retiring those two is tracked in [#4](https://github.com/tuanemuy/fog/issues/4); it changes nothing the runtime reads.

The staleness check for this chapter is therefore not the word D1 but four English literals — the shared table of processed events, and standalone Workers for relaying, pruning and dead-lettering:

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

**That the request side points at the TanStack Start source entry is why the request Worker cannot be deployed** (tracked in [#3](https://github.com/tuanemuy/fog/issues/3)), not an incidental detail: `wrangler deploy` cannot resolve `#tanstack-start-entry`, `#tanstack-router-entry` or `tanstack-start-manifest:v`, which only the Vite plugin supplies. The templates' own headers say so.

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

`{ protect: true }` is set on the **D1 database and nothing else**. It stops `pulumi destroy` and stops a resource-replacing edit from deleting the database. The database holds nothing the runtime reads (chapter 1); the protection stays until the resource is removed from the stack ([#4](https://github.com/tuanemuy/fog/issues/4)), so that the removal is an explicit step and not a side effect.

**Reality: Available.** To remove the protection when D1 is retired from the stack ([#4](https://github.com/tuanemuy/fog/issues/4)):

```bash
# from the repo root
pulumi -C infra/cloudflare/pulumi/resources -s <stage> state unprotect \
  'urn:pulumi:<stage>::tanstack-start-template-cf-resources::cloudflare:index/d1Database:D1Database::db'
# then remove the resource from index.ts and run `pulumi up`
```

`pulumi state unprotect --all` clears every protected resource in the stack at once and should not be used here — there is exactly one, and naming it is the point.

## 3. Secrets: ownership and procedure

**Reality: Available** (installing a secret is a command you can run today; the deploy it prepares for is blocked at the request Worker's bundling, 4.2 and [#3](https://github.com/tuanemuy/fog/issues/3)).

`apps/web/.dev.vars.example` is the authority for ownership; its header table is the roster and `wranglerConfig.test.ts` pins every secret row of it. Fifteen secrets and three `[vars]` entries:

| Secret | Owner | What it is |
| ------ | ----- | ---------- |
| `SESSION_SECRET` | **request** | HMAC key signing session cookies. The Worker refuses every request until it is set |
| `MAIL_PROVIDER_API_KEY` | **request** | Mail provider credential. The consumer runs in `queue()` on this Worker, so the provider is called from here |
| `DIRECTORY_ROUTING_SECRET` | **request** | HMAC key mapping a canonical address to its Identity Directory bucket (generation 1, 16 buckets). Bucket selection happens in the stub-selection adapter, *before* any DO is entered. Not read while `DIRECTORY_ROUTING_KEYRING` is set |
| `DIRECTORY_ROUTING_KEYRING` | **request** | The two-generation form of the routing key — a JSON array of `{ role, generation, key, bucketCount }`, one `active` and at most one `previous` — deployed for the duration of a mapping-key rotation (below) |
| `AI_CLIENT_TOKEN_SECRET` | **request** | Key material of the AI API's tokens, authorization codes and client ids |
| `OPERATOR_TOKEN` | **request** | Bearer of the maintenance surface `/__operator/*` (8.2); at least 32 characters, and the surface does not exist while it is unset |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **request** | The SSO callback runs there |
| `IDENTITY_MAIL_ENCRYPTION_KEY` | **state** | AES-256-GCM key protecting `credential_mappings.encrypted_canonical` (generation 1). Never leaves the DO. Not read while `IDENTITY_MAIL_ENCRYPTION_KEYRING` is set |
| `IDENTITY_MAIL_ENCRYPTION_KEYRING` | **state** | The two-generation form of the encryption key — `{ role, generation, key }` × (active + at most one previous) — deployed for the duration of an encryption-key rotation |
| `DIRECTORY_KEY_COMMITMENT` | **state** | What a bucket verifies an injected routing key against: the same role-tagged generation set as `DIRECTORY_ROUTING_KEYRING` with `keyDigest = SHA-256(key)` in place of each key. Digests, never keys — the state Worker still cannot compute where a credential lives |
| `PROVIDER_IDEMPOTENCY_KEY` | **state** | HMAC key each DO derives `providerIdempotencyKey` from. Never leaves the DO |
| `IDENTITY_RESET_TOKEN_KEY` | **state** | The reset-token derivation key. Never leaves the DO |
| `MAIL_DEV_SINK`, `SSO_DEV_STUB` | request, **local only** | The development mail sink (`"console"`, chapter 13) and the development identity provider (`"true"`). Not secrets; `wranglerConfig.test.ts` fails if a deployed config declares them |
| `APP_URL`, `MAIL_FROM_ADDRESS`, `DIAGNOSTICS_ENABLED` | `[vars]` of the request config | Not secrets. The templates take the first two from the environment at render time; the third is declared in `wrangler.toml` only (chapter 6) |

**`DIRECTORY_ROUTING_SECRET` and `IDENTITY_MAIL_ENCRYPTION_KEY` are deliberately given to opposite Workers.** The request Worker can compute *where* a credential lives but cannot read the address back; the state Worker can read the address back but cannot compute where it lives. Handing either key to both Workers collapses that split, and no code notices. The commitment keeps the split during a rotation: the state Worker verifies an injected key by its digest and never holds the key.

**So do not write "the derivation keys never leave the DO" without qualification.** The three derivation keys do stay inside the DO (`IDENTITY_MAIL_ENCRYPTION_KEY` and its keyring, `PROVIDER_IDEMPOTENCY_KEY`, `IDENTITY_RESET_TOKEN_KEY`). `DIRECTORY_ROUTING_SECRET` is a *mapping* key and lives on the request Worker by design — it is not one of them. Stating the rule too broadly is how it ends up copied into the state Worker "for consistency".

### Generating and installing

```bash
openssl rand -base64 48        # any of the single-value secrets
```

Install each secret **against the config of the Worker that owns it** — the `--config` flag is the whole of the ownership enforcement:

```bash
# from apps/web — `wrangler` is a devDependency of @repo/web, and the
# --config paths are relative to that directory. From elsewhere, run it as
# `pnpm --filter @repo/web exec wrangler secret put …`.
wrangler secret put SESSION_SECRET               --config wrangler.staging.toml
wrangler secret put MAIL_PROVIDER_API_KEY        --config wrangler.staging.toml
wrangler secret put DIRECTORY_ROUTING_SECRET     --config wrangler.staging.toml
wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEY --config wrangler.state.staging.toml
wrangler secret put PROVIDER_IDEMPOTENCY_KEY     --config wrangler.state.staging.toml
wrangler secret put IDENTITY_RESET_TOKEN_KEY     --config wrangler.state.staging.toml
wrangler secret put AI_CLIENT_TOKEN_SECRET       --config wrangler.staging.toml
wrangler secret put OPERATOR_TOKEN               --config wrangler.staging.toml
wrangler secret put DIRECTORY_ROUTING_KEYRING    --config wrangler.staging.toml
wrangler secret put DIRECTORY_KEY_COMMITMENT     --config wrangler.state.staging.toml
wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEYRING --config wrangler.state.staging.toml
wrangler secret put GOOGLE_CLIENT_ID             --config wrangler.staging.toml
wrangler secret put GOOGLE_CLIENT_SECRET         --config wrangler.staging.toml
```

The three rotation variables are installed only for the duration of a rotation and removed again after retirement (below).

Getting one wrong **works locally and breaks first in staging** — see below.

### Rotation policy

| Secret | Rotation | Consequence of rotating |
| ------ | -------- | ----------------------- |
| `SESSION_SECRET` | rotate freely | every session cookie is invalidated; users log in again |
| `MAIL_PROVIDER_API_KEY` | rotate freely, provider-side | none |
| `DIRECTORY_ROUTING_SECRET` | **never rotate in place** | the bucket of every existing credential changes and nothing is findable; rotating it is the mapping-key transfer below |
| `IDENTITY_MAIL_ENCRYPTION_KEY` | **never rotate in place** | every `encrypted_canonical` becomes undecryptable; rotating it is the `rotate-encryption` procedure below |
| `PROVIDER_IDEMPOTENCY_KEY` | rotate freely | in-flight deliveries derive a different key and the provider may send one duplicate; delivery is at-least-once already |
| `IDENTITY_RESET_TOKEN_KEY` | rotate with care | tokens derived under the old key stop resolving; unused reset links die |
| `AI_CLIENT_TOKEN_SECRET` | rotate with care | every AI client's tokens and codes are invalidated; clients re-authorise |
| `OPERATOR_TOKEN` | rotate freely | operators pick up the new value |

### Rotating the two keys that cannot be rotated in place

**Reality: Available** as a procedure (`spec/rotation/index.md` is the authority on the rules; this is the operator's sequence). Both rotations run through the maintenance surface (8.2) and never at the same time — `remap-chunk` refuses while the encryption keyring holds a `previous` entry, and `start-rotate-encryption` refuses while the commitment holds a `previous` mapping generation.

**Mapping key.** (1) Deploy, as a pair, `DIRECTORY_ROUTING_KEYRING` (request: `active` = the new generation g+1, `previous` = the current generation g) and `DIRECTORY_KEY_COMMITMENT` (state: the same set with digests). From that moment new reservations land in g+1 and lookups probe active → previous → active once more. (2) For every bucket `0 .. bucketCount-1` of generation g, call `remap-chunk` with the two keyring entries in the body until it answers `lastCredentialId: null` — the CLI does this as `node apps/web/scripts/operator.ts remap-chunk --locator dir:g<g>:b<n> --inject-keyring --limit 100 [--after <id>]`, reading the entries from `.dev.vars` so that no key is typed on a command line. (3) Read `read-rotation-checkpoint` with `{ "rotationKind": "remap", "generation": <g> }` on every one of those buckets; retirement holds only when every bucket answers `previousCount: 0` (a bucket answering `null` has not been scanned). (4) Deploy the pair again without the `previous` entries; generation g's buckets are no longer addressable. The JSON shapes are in `.dev.vars.example`. Measured locally on PH-09B: one chunk over 0–4 rows takes 121–146 ms including its two RPCs per row — an observation, not a figure to plan by.

**Encryption key.** (1) Deploy `IDENTITY_MAIL_ENCRYPTION_KEYRING` (state) with `active` = the new generation and `previous` = the current key. (2) Call `start-rotate-encryption` on every bucket of the **active mapping generation**; it enqueues the `rotate-encryption` job and the Alarm rewrites the rows. (3) `read-rotation-checkpoint` with `{ "rotationKind": "encryption", "generation": <retiring> }` on every one of those buckets; all `previousCount: 0` is the retirement condition. (4) Remove the `previous` entry.

**Order between the two.** Start a mapping-key rotation only after an encryption-key rotation has retired, and the reverse — the guards make a violation harmless but wedge whichever started second until the other side is rolled back.

**Limits.** `read-rotation-checkpoint` and `remap-chunk` pass through the migration gate, so a bucket nobody has addressed before is initialised by the read (it holds no rows, so the checkpoint it then writes is `previousCount: 0`). A `rotate-encryption` chunk in which not one row decrypts ends `SystemError(DataIntegrityError)`, is backed off by the runner and turns `poison` after `jobsMaxAttempts` — the spec does not name this case; it is the runner's answer to a chunk that could not otherwise make progress.

### The split does not hold locally

`wrangler dev -c wrangler.toml -c wrangler.state.toml` resolves `.dev.vars` relative to the config directory, and both configs sit in `apps/web/`. **Every entry in `.dev.vars` is therefore visible to both Workers locally** — measured: the state Worker also receives `SESSION_SECRET` and `DIRECTORY_ROUTING_SECRET`. The ownership above only becomes real from staging onward, where `wrangler secret put --config` puts each secret on one Worker. The same holds for the rotation pair: locally the commitment and the keyring sit side by side, so the non-overlap the design relies on cannot be observed under `pnpm dev`.

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
# 3. install the secrets against their owning config (see chapter 3)

# 4. set the DLQ retention out of band — it is not a wrangler key
wrangler queues update <prefix>-events-dlq --message-retention-period-secs 600
```

Step 4 is **mandatory, not an adjustment**. `wrangler queues create/update` omits `settings.message_retention_period` from the request when the flag is absent, so an unconfigured queue keeps Cloudflare's documented default of 4 days — at which both delivery constraints (chapter 12) are broken at once. `wranglerConfig.test.ts` pins the seconds in the template headers against the declared `dlqRetentionMs`, so moving one without the other turns the suite red. **What is pinned is the instruction, not the queue**: whether anyone ran it is observable nowhere in this repository.

### 4.2 Steps that only mean something after the deploy

**Reality: None ([#3](https://github.com/tuanemuy/fog/issues/3)) for the request Worker half.**

```bash
# from the repo root (both are root scripts that delegate to @repo/web)
# 5. state Worker FIRST, then the request Worker
pnpm deploy:<stage>:state     # works
pnpm deploy:<stage>           # fails while bundling the request Worker (#3)
pnpm deploy:<stage>:all       # runs the two in that order; only the first half lands

# 6. bind the hostname
pulumi -C infra/cloudflare/pulumi/routes -s <stage> up
```

**The order is not a preference.** The request Worker's DO bindings name the state Worker's script, and a binding cannot be created against a script that does not exist. The routes stack comes last for the same reason one level up: Cloudflare rejects a custom-domain binding for a service that has not been uploaded.

`pnpm deploy:<stage>` fails today because `main` is the TanStack Start source entry and `wrangler` cannot resolve its virtual modules — the same unresolved point that keeps `pnpm start` from booting. Until [#3](https://github.com/tuanemuy/fog/issues/3) closes, **the request Worker cannot be deployed at all**, and everything downstream of it in this document is unreachable in production regardless of what else is true.

### 4.3 Rollback

**Data is never rolled back.** Schema is forward-only; there are no down migrations.

Code can be rolled back, but a DO whose `_meta.schema_version` is ahead of what the code understands **fails closed** (chapter 6). The gate compares the stored version against the target declared by **the state Worker's own bundle** (`migrationGate.ts`), so both ways a DO can get ahead of its code are on that side: **rolling the state Worker back**, and the **propagation window of a state deploy**, where an object migrated by an isolate running the new bundle is next served by one still running the old. Therefore:

> **A release that advances the schema is a release that cannot be rolled back.** Treat it as one-way at plan time, not at incident time.

**A fail-closed DO also burns the messages already published from it.** The consumer picks one up and calls that DO's send-materials RPC; the RPC runs behind the migration gate, the gate answers `SystemError`, the consumer retries until `max_retries` is exhausted, and the message lands in the DLQ. **The DLQ handler re-drives it once and acks it** (8.6) — if the DO is still fail-closed at that moment, that one delivery is gone and the only exit is the user asking again.

The fallback for a bad schema release is PITR (chapter 11), which restores **one DO at a time** and cannot restore several to a common point.

### 4.4 The skew window, and what it burns

Deploys are not atomic across the two Workers, and the deploy order decides which side is ahead.

> **The state Worker lands first, so the emitter runs ahead of the consumer.** A DO on the new bundle may publish an `event.type` — or a routing key — that the deployed request Worker cannot route. `handleEventsBatch` answers both with `message.retry()` rather than `ack()`, the retries are exhausted, and the message lands in the DLQ. **The DLQ handler re-drives it once and acks it** (8.6); unless the request deploy landed in between, that delivery is gone and the only exit is the user asking again.

Retrying rather than acking is deliberate: an ack would discard a message against an at-least-once contract, and the DLQ is the disposition `spec/async/index.md` gives a consumer failure. The window stays open for exactly as long as the two deploys are apart, which is one more reason not to leave `deploy:<stage>:all` half-run.

**The migration gate is not what burns a message in this window.** It compares against the target the state Worker's own bundle declares, so advancing the schema forward never puts a DO ahead of the code that owns it. The gate's two cases are in 4.3.

The two directions are not symmetric, and confusing them is the common mistake:

- **DO side** — a DO that is not relaying — a fail-closed one (4.3) — piles up `outbox_events` rows. **That backlog is not lost delivery.** The rows are still there and flow on the first wake-up after the code catches up.
- **Queue side** — a message that was already published is past the point where the DO can help. It is burned, here and in 4.3 alike.

Section 8.6 refers back to this paragraph rather than restating it.

### 4.5 `pnpm preview`

**Reality: Local only.**

`pnpm preview` serves the build output through `vite preview`, so `pnpm build` (= `build:cf`) must have run first; it reads `.wrangler/deploy/config.json` to find that output. **`APP_URL` is pinned to `http://localhost:3000` in `wrangler.toml`**, and `vite preview` picks its own port — so `og:url` and the canonical link will disagree with the address in the browser bar. That is expected in preview and is not a signal of a misconfiguration.

`pnpm start` (`wrangler dev` over both configs) — see `README.md` for its current status; it fails for the same cause as the deploy ([#3](https://github.com/tuanemuy/fog/issues/3)).

**`pnpm dev` and `pnpm preview` share `apps/web/.wrangler/state`.** Run one at a time: two processes over the same Durable Object files compete for the same Alarms, and a job may run in whichever process fires first. Preview's `[dev-mail]` lines carry `APP_URL`'s host (`:3000`), so a reset link printed by preview has to be opened against preview's own port by hand.

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

**Reality of detecting it: Available.** `POST /__operator/read-schema-version` (8.2) answers the stored version for one bucket or one User Data DO, is outside the gate, and reaches production with `OPERATOR_TOKEN`. `GET /__diagnostics/schema-version?locator=dir:g1:b0` is the local counterpart — the route only exists where `DIAGNOSTICS_ENABLED = "true"`, declared in `wrangler.toml` and deliberately absent from all four templates. The sweep that builds a blast radius is 7.4.

**Local workerd and the Alarm's `id.name`.** After `pnpm dev` restarts, workerd fires pending Alarms on Durable Objects it restores without handing them `ctx.id.name`. `requireSelfLocator()` falls back to `_meta.self_locator`, the copy the gate wrote at initialisation, so the relay and the jobs pass run on such an object; an object that was addressed but never initialised has neither, and its wake-up logs `Alarm stopped at the schema gate` and re-arms at the fail-closed interval. The production runtime carries the name on every activation. Treat that log line right after a restart as this, not as a schema problem.

### Discarding local DO state

**Reality: Local only.** There is no npm script; the command is the procedure.

```bash
# from the repo root
rm -rf apps/web/.wrangler/state
```

**This is mandatory after any index-definition change.** An initialised local DO already carries `schema_version = 1`, so the gate skips v1's step and the edited DDL is never issued against it — the object keeps the old definition forever and `pnpm dev` silently runs the old plan.

**No `EXPLAIN QUERY PLAN` test is affected by any of this**, and that holds for ones added later rather than for a fixed list: every such assertion runs in the `durable-objects` vitest project, whose `include` claims the whole of `packages/core/src/adapters/cloudflare/`, and `vitest.config.do.ts` sets no `miniflare.persist`, so the DO pool builds its objects in memory and reads zero bytes of `.wrangler/state`. At the time of writing they are `__tests__/alarmSchedule.integration.test.ts` for the Alarm's re-arm minima, `__tests__/rowRunner.integration.test.ts` for the claim `SELECT`, and `stores/__tests__/memoTimelinePlan.integration.test.ts` for the timeline reads (`memos_timeline_idx`: an ordered walk for a first page, a seek from the cursor, a seek on `posted_at` for a date anchor, a key seek for a memo anchor, a keyword applied inside the same index). If one is red, local state is not the reason.

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

**The limit is production, and it is total.** There is no way to touch a deployed DO's storage. What is observable from outside is what the maintenance entries return (chapter 10): the schema version, the delivery backlog, the quarantined and poisoned rows, a bucket's user ids and its rotation checkpoints — projections, never the rows.

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

Locally, read them from the DO's SQLite file (chapter 6). In production, `read-delivery-backlog` (8.3) answers the first three as counts and the oldest `created_at`, and `list-quarantined-events` (8.4) the fourth — for one object per call. Nothing notifies an operator of stuck delivery; these reads are pulled, not pushed (tracked in [#7](https://github.com/tuanemuy/fog/issues/7)).

### 7.4 Finding a fail-closed DO

**Reality: Available, one object per call.**

`read-schema-version` (8.2) answers for the bucket or the `userId` you name, and it does so on a fail-closed object because it does not pass the gate. **Durable Objects cannot be enumerated by the platform**, and the reverse map from a DO's internal id to a `userId` does not exist, so a sweep is built from the buckets: `list-bucket-user-ids` on each of the active generation's `bucketCount` buckets — also outside the gate, so a fail-closed bucket still names its accounts, and an uninitialised one answers `[]` without being initialised — then `read-schema-version` per `userId`. That is `bucketCount + N` calls for N accounts, and it is the only way to find a stopped object short of a user reporting an error. The local diagnostic route (`GET /__diagnostics/schema-version`) takes bucket-shaped locators only — accepting the `userId` form there would answer "does this account hold data" on an unauthenticated route.

### 7.5 `sweep-reset-tokens` keeps a bucket armed

**Reality: Available.** The handler is registered on the Identity Directory class and the password-reset request path enqueues it.

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

### 8.2 The operator path

**Reality: Available.** `POST /__operator/<entry>` on the request Worker reaches every maintenance entry of chapter 10, on both Durable Object classes. The handler is `apps/web/app/worker/cloudflare/operatorHandlers.ts` — a bare Worker handler that goes through no TanStack Start code, the same shape as `queueHandlers.ts` — and `apps/web/app/server.cloudflare.ts`'s `fetch` routes to it right after the diagnostic route. The body is `{ "locator": …, ...args }`, validated with Zod per entry; the DO stub is taken from `doStubs.ts`; the RPC envelope is unwrapped by `callDurableObject`, and the answer is `{ ok: true, result }` or `{ ok: false, error }` with the Durable Object's serialized error verbatim and the status its `kind` maps to — the operator is who reads internals.

**(a) Reach.** The surface exists only while the request Worker holds `OPERATOR_TOKEN` (chapter 3; at least 32 characters). The answers, in the order they are decided: **404** when the secret is unset or shorter than that — the surface is absent, not open; **404** for an entry name not in chapter 10; **405** for anything but `POST`; **401** when the bearer does not match, compared in constant time; **400** for a locator the entry does not accept, a body that is not an object, or arguments that fail the entry's schema. `DIAGNOSTICS_ENABLED` is not reused for this: its containment is what keeps the diagnostic route out of production.

**Locator validation is per entry and is not just a regular expression.** `dir:g<generation>:b<bucket>` is accepted only for a generation the request Worker's keyring declares and a bucket index below that generation's `bucketCount` — both entries of the keyring while a rotation is open, so the retiring generation's buckets stay addressable for `remap-chunk` and `read-rotation-checkpoint`, and generation 1's sixteen otherwise. The Identity Directory class initialises on first contact, so an unchecked `dir:g9:b999` would create an empty object nothing can ever find. A `userId` locator is accepted by the entries that target User Data.

**(b) Who operates it.** Cloudflare Access in front of the request Worker's hostname is the operational control — per-operator identity, rate limiting and an audit trail at the edge, configured outside this repository (`infra/` does not carry it). `OPERATOR_TOKEN` is the surface's own gate and holds where Access is not in front of it; on its own it cannot say *which* operator acted, which is why the two are used together. Chapter 14 tracks the identity limit.

**(c) Audit log — an allow-list.** One `info` line per call, `operator { entry, locator, outcome, id? }`: `outcome` is `ok` or the error's `code`; `id` is the acted-on identifier where the entry has one — `eventId` for the quarantine re-drive and deletion, `operationKey` for the poison ones, `userId` for `purge-user-mappings`, `afterCredentialId` for `remap-chunk`, `credentialId` for `record-remapped-locator` — and nothing else. **The request and response bodies are never copied**: not `payload`, not `owner_token`, not `terminal_reason`, not a keyring entry, not a verifier, not a caller token. The unit test pins that none of those reaches the line.

**(d) The CLI.** `node apps/web/scripts/operator.ts <entry> --locator <dir:gN:bM | userId> [--json '{…}'] [--inject-keyring] [--limit N] [--after <credentialId>] [--base http://localhost:3000]`, run from `apps/web` (also `pnpm --filter @repo/web operator …`). The bearer comes from `OPERATOR_TOKEN` in the environment or from `.dev.vars`; `--inject-keyring` reads `DIRECTORY_ROUTING_KEYRING` (or `DIRECTORY_ROUTING_SECRET` as generation 1) from the same file and adds the `active` / `previous` entries to the body, so a key is never typed on a command line. Against a deployed stage the same body goes through Access.

**(e) Escalation.** Fail-closed DOs (7.4) and `poison` rows (8.5) escalate through this same path. There is no separate channel for them.

### 8.3 Watching the backlog

**Reality: Available.** `read-delivery-backlog`, both classes:

- **Reads only.** Writes no row, does not call `rearm()`.
- **Behind the migration gate.** **On a fail-closed DO this RPC itself answers `SystemError`** — it does not pass through and report zero. That property is what makes the next paragraph work.
- **Returns three values**: `pendingCount`, `publishingCount`, and `oldestCreatedAt` (the minimum `created_at` over `status IN ('pending','publishing')`, or `null`).
- **Does not count `quarantined`.** Those are terminal and have their own listing.
- Returns no `payload`, no `owner_token`, no `aggregate_id`, no `event.id`.

**A fail-closed DO does not present as a growing backlog. It presents as a backlog you cannot read.** The counts come back as an error, not as numbers. To tell the two apart, call `read-schema-version`, which is outside the gate: it answers a version on a fail-closed DO and `null` on an uninitialised one.

### 8.4 The DO side: quarantined events

**Reality: Available.** Three entries, both classes.

A row reaches `quarantined` when the relay's publish attempts are exhausted (`relayMaxAttempts`, 5). It is terminal, it is **never pruned**, and it only leaves that state by operator action.

**`list-quarantined-events`.**

- Six columns: `eventId`, `type`, `attempt`, `createdAt`, `completedAt`, `terminalReason`. Each omission has its own reason: `owner_token` is a bearer credential for the send-materials guard; `aggregate_id` is the throttle-window key and would correlate messages to one recipient; `payload` is not what explains a quarantine — `terminal_reason` is.
- **Page size 50** (`listQuarantinedEventsLimit`). A cap is required rather than nice to have: quarantine is permanent and happens *en masse* — a failed queue producer binding quarantines everything at once — so an uncapped listing would be the one path in the system that grows with row count.
- **Keyset cursor on `(completed_at, id)`**, ascending by `completed_at`, returned as `nextCursor` and passed back as `cursor`. **Not an offset**: mass quarantine is the case this listing exists for, and operators page through it while re-drives are removing rows underneath, which makes an offset skip whatever shifted down. `outbox_completed_idx` is `(status, completed_at)`, so this order needs no sort; only the `id` tie-break within one `completed_at` does.

**Paging through a mass quarantine.** Take a page, act on every row in it, then request the next page **with the cursor from the page you took, not from the page you would have taken after acting**. Re-driven rows leave the set, so a re-driven page shrinks the remainder rather than shifting it; the keyset cursor stays valid across that. When the cursor comes back `null` the set is drained. If new quarantines are arriving faster than you re-drive, the cause is upstream (see 8.8) and paging will not converge — fix the cause first.

**`requeue-quarantined-event`** (`{ "eventId": … }`).

Writes five columns in one statement: the four state columns — `status = 'pending'`, `next_run_at = now`, `attempt = 0`, `completed_at = NULL` — and a **re-minted `owner_token`**. `terminal_reason` is **kept** — it is the only record of why the row was quarantined. Re-minting the token is the only thing that closes the exposure window: any `(event.id, owner_token)` pair that reached the queue or the DLQ before the quarantine stops passing the send-materials guard. The transaction is followed by a `rearm()`, which is not optional — a DO holding only quarantined rows is by definition disarmed, and that is precisely the situation an operator is re-driving from. Answers `{ requeued: boolean }`.

**Try the re-drive before anything else.** It is the only action that closes the token window, and it is safe to run twice.

**`delete-quarantined-event`** (`{ "eventId": … }`).

- One RPC deletes one row. `WHERE id = ? AND status = 'quarantined'` — two equality conditions, no range, no bulk form.
- Reads the matched row count back and returns `{ deleted: boolean }`.
- **Does not call `rearm()`** — deleting a row adds no runnable work.
- Audited.

**Its scope is narrow on purpose.** A row whose materials have expired does not need deleting: re-drive it, the send-materials RPC answers `nothing-to-send`, the row reaches `published` and prune removes it on schedule. **Explicit deletion is for rows that will not leave `pending` even after a re-drive** — and nothing else. Reaching for it first throws away the token re-minting that the re-drive performs.

### 8.5 The DO side: poisoned jobs

**Reality: Available.** Three entries, both classes.

A job reaches `poison` when forward progress is exhausted — or, for a row that has a rollback stage, when that rollback ends without completing. **`poison` rows are never pruned**, for the same reason quarantined rows are not: the row is the only record of the residue, and it is the thing a re-drive acts on. Deleting it on a retention timer would leave the residue and remove the record.

**`list-poisoned-jobs`.**

- Five columns: `operationKey`, `kind`, `attempt`, `completedAt`, `terminalReason`. `payload` is omitted for the same reason as above.
- **Page size 50** (`listPoisonedJobsLimit`) and **keyset cursor on `(completed_at, operation_key)`**, ascending by `completed_at` — matching the quarantine listing deliberately, so an operator learns one paging discipline. The tie-break is `operation_key` rather than `id` because `jobs` is keyed on `operation_key` and the five returned columns contain no `id`. `jobs_completed_idx` is `(status, completed_at)`, so the order needs no sort.
- `terminalReason` is the six-value vocabulary of `spec/database/index.md` — `forward-exhausted`, `forward-conflict`, `cleanup-exhausted:<forward>`, `cleanup-material-lost:<forward>` and their kin — followed by a space and the `operationId` where the job has one.

**`requeue-poisoned-job`** (`{ "operationKey": … }`).

Writes the same four state columns as the quarantine re-drive — `status = 'pending'`, `next_run_at = now`, `attempt = 0`, `completed_at = NULL` — keeps `terminal_reason`, and re-arms. `payload` and `payload_digest` are **not** replaced: this is a re-drive of the same work, not a re-submission of different work. A row with a rollback stage resumes at that stage; one without resumes forward. Answers `{ requeued: boolean }`.

**Rows whose `terminal_reason` starts with `cleanup-material-lost:` are not re-drive candidates.** That reason means the rollback found its materials already gone; re-driving can never make progress, and doing it in bulk turns a bounded incident into an unbounded loop. Those rows are what explicit deletion is for.

**`delete-poisoned-job`** (`{ "operationKey": … }`).

- One RPC deletes one row. `WHERE operation_key = ? AND status = 'poison'` — two equality conditions.
- Returns `{ deleted: boolean }`.
- **Does not call `rearm()`.**
- **This is where `cleanup-material-lost:*` rows are disposed of**, after their residue has been dealt with by hand.

### 8.6 The queue side: the DLQ

**Reality: Available, automatic, and once.** There is no manual re-drive and no listing.

**The DLQ handler re-drives each message once, then acks it.** `handleDlqBatch` in `apps/web/app/worker/cloudflare/queueHandlers.ts` runs every message through the same `deliverOnce` the events consumer uses, logs one line — `dlq { eventId, type, outcome }` with `outcome` one of `sent`, `nothing-to-send`, `unserved`, `failed` — and calls `message.ack()` whatever the outcome; the batch is acked as a whole afterwards. The DLQ has no DLQ of its own, so there is no second attempt. A message is in the DLQ because the events consumer failed it four times (the first delivery and `max_retries = 3` more); the one further attempt catches the case where the cause has cleared in between — a request deploy that landed, a DO that is no longer fail-closed.

**That single re-drive cannot send twice.** The send-materials guard checks the message's `(event.id, owner_token)` pair against the row: a row the relay re-claimed since carries a new token and answers `nothing-to-send`, and so does one an operator re-drove through `requeue-quarantined-event`. Running the two paths against the same event is safe.

**What you get in the log is `event.id`, `type` and the outcome, and nothing else.** That is the whole of what the hygiene rules allow about a queue message. **In production, not even that is retained**: no wrangler config in this repository declares an `[observability]` block, so nothing keeps the line past the invocation that wrote it — see 8.7 (tracked in [#5](https://github.com/tuanemuy/fog/issues/5)).

**What is lost and what remains when the re-drive also fails:**

- **Lost**: that message — one delivery attempt of that event.
- **Remains**: the `published` row in the emitting DO, and the log line.
- **The row cannot be used to recover it.** It is `published`, not `quarantined`, so `requeue-quarantined-event` does not apply to it and there is no DO-side entry that does.

**The typical way a message ends up here is the deploy skew window** described in 4.4 — the deployed consumer cannot route the type or the routing key and burns its retries. The other way is a fail-closed emitting DO (4.3), whose send-materials RPC answers `SystemError` behind the migration gate. In both, if the re-drive misses too, the user asking again is the only exit.

**On the queue side an operator gets one log line and one automatic attempt.** There is no manual re-drive and no pull consumer: `spec/async/index.md` defines the DLQ's handling as that one automatic attempt followed by the ack.

Do not raise `message_retention_period` in response to any of this — see chapter 5 for why it buys nothing.

### 8.7 Who may reach the DLQ

**The pair `(event.id, owner_token)` is a bearer credential.** Anyone holding it can call the send-materials RPC and receive the recipient address and the raw reset token, because those two values *are* the guard. Nothing else is checked. A queue message carries both.

Therefore:

- **Restrict who can read the DLQ** to the same people who may reach the operator path (8.2). It is not a lower-sensitivity surface than the maintenance entries; it is the same sensitivity by a different route.
- **Keep no copy of a message.** Not in a ticket, not in a paste, not in an incident channel.
- **The reach control covers the log readers too.** The message itself is acked within seconds and is gone. The log line is written regardless — but **nothing in this repository retains it in production**: none of the six wrangler configs declares an `[observability]` block, so Workers Logs is off (tracked in [#5](https://github.com/tuanemuy/fog/issues/5)). What is readable in production today is the standard output of a `wrangler tail` session for as long as somebody holds one open, so the reach control applies to whoever that is. The log carries only `event.id` and `type`, which is deliberately not enough to pass the guard on its own, but it is the durable half of a credential and the audience for it should be the operator audience.
- **Never forward the DLQ to an external monitoring or log-aggregation sink.** That prohibition is the price of carrying `owner_token` on the message at all.

### 8.8 Storage pressure

**Monitoring item: `quarantined` and `poison` never shrink on their own.** Everything else the DO stores is self-limiting — `done` and `published` rows are pruned on a retention timer — but these two are permanent by design and leave only by operator action. A delivery outage therefore converts directly into storage growth, and the growth continues until somebody acts.

The cap is 10 GB per Durable Object, counting the base tables and the FTS5 index together. **Near the cap a DO half-dies: writes fail while reads and `DELETE` still succeed.** Every recovery path has to work without a single write, which is why the export and deletion paths are shaped the way they are.

**Identity Directory DOs are shared by many users.** Pressure in one bucket is not one user's problem — it reaches everyone whose credential hashes to that bucket. A single account attracting a flood of quarantined rows can push a whole bucket toward the cap, and the mechanism that bounds it is per-origin rate limiting, which this repository does not provide (9.4, tracked in [#8](https://github.com/tuanemuy/fog/issues/8)).

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

**Reality: None ([#8](https://github.com/tuanemuy/fog/issues/8)).** Nothing rate-limits by origin today.

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

All fifteen are implemented and reachable through `POST /__operator/<entry>` while `OPERATOR_TOKEN` is set (8.2). Reach control for every row is the same; no entry gets its own.

| Entry | Target | Gate | Re-arms | Body (besides `locator`) |
| ----- | ------ | ---- | ------- | ------------------------ |
| `read-schema-version` | both classes | **outside** — answers a fail-closed or uninitialised object | no | — |
| `read-delivery-backlog` | both classes | inside | no | — |
| `list-quarantined-events` | both classes | inside | no | `cursor?` |
| `requeue-quarantined-event` | both classes | inside | **yes** | `eventId` |
| `delete-quarantined-event` | both classes | inside | no | `eventId` |
| `list-poisoned-jobs` | both classes | inside | no | `cursor?` |
| `requeue-poisoned-job` | both classes | inside | **yes** | `operationKey` |
| `delete-poisoned-job` | both classes | inside | no | `operationKey` |
| `list-bucket-user-ids` | Identity Directory | **outside** — a fail-closed bucket still names its accounts; an uninitialised one answers `[]` and stays uninitialised | no | — |
| `purge-user-mappings` | Identity Directory | inside | no | `userId` |
| `start-rotate-encryption` | Identity Directory | inside | **yes** (enqueues `rotate-encryption`) | — |
| `remap-chunk` | Identity Directory (the retiring generation's bucket) | inside | no | `active`, `previous` (keyring entries), `limit`, `afterCredentialId?` |
| `import-remapped-mappings` | Identity Directory (the active generation's bucket) | inside | no | `active`, `rows` (at most 3) |
| `record-remapped-locator` | **User Data** | inside | no | `callerToken`, `credentialLocator` |
| `read-rotation-checkpoint` | Identity Directory | inside | no | `rotationKind`, `generation` |

**The rotation entries are operated as chapter 3 describes**; `remap-chunk` drives `record-remapped-locator` and `import-remapped-mappings` itself, one row at a time, so an operator calls those two directly only to repair a single row by hand. The PITR interaction is 11.3 (c).

**`cancel-reservation` is not on this list and is not an operator entry.** It requires a `callerToken`, and the only path that returns that value needs the user's own valid session — so an operator cannot execute it. Its callers are the automatic rollback stages (the coordinator bucket and the User Data DO). **The operator's entry into a terminated saga is `requeue-poisoned-job`.**

**Entries that only read do not re-arm the Alarm**, and the three deletion / purge entries do not either — removing a row adds no runnable work. Everything that writes a runnable row re-arms: the two re-drives and the rotation start. `remap-chunk` writes rows and a checkpoint but no runnable row, so it does not.

## 11. Data lifecycle

### 11.1 Per-user export

**Reality: Available.** `POST /export` from the settings page's data section (S-ST-02); the handler is `apps/web/app/presentation/export/handler.ts` and it accepts only a same-origin request (`Origin`, else `Sec-Fetch-Site`) from a logged-in session — 405 for other methods, 401 without a session, 403 across origins.

All of a user's data is inside one Durable Object, so an export is one `transactionSync` in one place — no cross-object join, no consistency problem. **The read is not split**, because splitting it would lose the snapshot's consistency.

Not splitting means the size is bounded instead. **The cap is `EXPORT_MAX_SOURCE_BYTES` = 24 MiB of body bytes** (`packages/core/src/adapters/cloudflare/stores/exportSourceReader.ts`), summed inside the DO before any body is read; exceeding it is `SystemError(ExportTooLarge)` and the settings page shows its own message. No partial archive is ever produced. The number is a judgement against the Worker's CPU budget for rendering and zipping, not a measurement; the zip is deterministic (`mtime = exportedAt`) so two exports of unchanged data are byte-identical.

**Export is not a backup.** It excludes the trash and returns only current revisions, so it cannot stand in for PITR.

### 11.2 Withdrawal and complete deletion

**Reality: Available for the part that exists; a user-initiated withdrawal is out of scope of the spec.** The one path that puts an account into `deleting` is `abandon-account` — the rollback stage of a registration saga that could not complete — and it is what enqueues `finalize-withdrawal`.

Two objects hold a user, and the job removes the account's **reach**, not its content:

1. **Identity Directory buckets** — every `credential_mappings` row of the account in every generation, issued to the stashed coordinates (the buckets are shared, so rows are deleted and the buckets stay). A round that deleted nothing across two generations is issued once more after `deleteNoopReissueDelayMs` (chapter 12) before it counts as done, so a copy still landing from a mapping-key transfer cannot survive it.
2. **User Data DO** — `credential_locators`, the `ai_client_connections` (revoked), the spent authorization codes, and then the tombstone: `account.status = 'deleted'`, `caller_token = NULL`, `deleted_at` set, the session epoch advanced. **The object is not deleted**; memos, topics, documents and the `operations` records — including the `withdrawal` record the job writes on its first run to stash the coordinates — stay behind the tombstone, which every entry refuses.

Partial failure is normal and is handled by the job's own retry, not by an operator. What an operator sees when it cannot converge is a `poison` row (8.5), and the first response is `requeue-poisoned-job`.

**`purge-user-mappings` is the last resort**, for when the job cannot converge because the mapping rows themselves are the obstruction. It deletes an account's rows in one bucket directly, reservations included, with their reset tokens, and is the only entry that does; treat it as a manual override with no undo, run it after `requeue-poisoned-job` has been tried, and audit it. **Do not run it against a live account.** The bucket cannot see the account's status, so the entry will happily delete the mappings of an account that is `active`: its sessions stay valid, the settings page can no longer resolve the address and shows its error state (the logout control stays), and the same address can be registered again as a new `userId` while the old User Data DO remains as residue nothing can find. It is the last resort of a withdrawal, not a tool for anything else.

**Withdrawal only becomes irreversible once the PITR retention window has passed** — until then, restoring both the User Data DO and its bucket would bring the account back. That is why PITR against a withdrawn account is forbidden (11.3 (d)).

### 11.3 Point-in-time recovery

**Reality: the restore itself is a platform operation; the four mandatory steps below have their storage and no operator entry that writes it.** Every table and column they name exists in the v1 schemas; what does not exist is a maintenance entry that advances an epoch, revokes connections, deletes tokens or clears a lockout, so the steps are done locally with `sqlite3` (chapter 6) and in production not at all — no entry for them exists (tracked in [#6](https://github.com/tuanemuy/fog/issues/6)). **Running a restore today would leave revoked sessions, revoked connections and consumed reset tokens alive** — the default below, cutting everything, is not yet executable in production.

- **Retention: 30 days**, per Durable Object.
- **The unit of recovery is one DO.** There is no way to restore several objects to a common instant.
- **PITR finds nothing.** A DO's internal id does not map back to a `userId`, so the blast radius of an incident is built by the sweep in 7.4 — `list-bucket-user-ids` on every bucket of the active generation, then `read-schema-version` per `userId`, both outside the gate. **It is a way to recover a target you already know, not a way to find one.**

**Mandatory steps — all four, every time:**

| # | Object | Step | Why |
| - | ------ | ---- | --- |
| 1 | User Data DO — the `account.session_epoch` **column** | advance it to a monotonic value derived from the current time | restoring rolls it back and revoked sessions become valid again |
| 2 | User Data DO — the `ai_client_connections` **table** | set every row to `revoked` | same — revoked connections come back alive |
| 3 | Identity Directory bucket — the `password_reset_tokens` **table** | delete every row | consumed and deleted reset tokens reappear |
| 4 | Identity Directory bucket — the `credential_mappings.failed_attempts` and `.next_attempt_allowed_at` **columns** | set the first to 0 and clear the second | the restore may reinstate a lockout the user has already served |

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

**(b) `reset_request_windows` rolls back as well, and its effect does not depend on ordering.** Restoring returns the throttle windows to a past state, so `claimWindow` answers `true` again for a window that had already been consumed. The consequence is a fresh reset token issued — **which replaces every unused token, killing the link already in the user's hands** — plus a second email. Steps 1–4 do not prevent this: it fires whether they ran before or after. Clearing the table belongs with the four steps, on the same terms (locally with `sqlite3`; no entry in production).

**(c) A restored bucket's rotation checkpoint is void.** A checkpoint asserting `previousCount = 0` is permanently true only because no path can write rows into a previous generation — and **PITR is outside that argument**, since it restores rows that were deleted. So: **treat any checkpoint on a restored bucket as invalid, run `remap-chunk` against that bucket again until it answers `lastCredentialId: null`, and only then read `read-rotation-checkpoint` and judge retirement.** Re-read the checkpoints of every bucket immediately before the retirement deploy, as part of the same procedure. Skipping this retires a key whose old-generation rows are still readable.

**(d) PITR against a withdrawn account is forbidden.** Restoring the User Data DO and the bucket's `credential_mappings` rows together brings the account back, which is precisely why a withdrawal is not irreversible until the retention window has passed (11.2). The ban is what stops that window from being used to undo a completed withdrawal.

An exception is possible — a withdrawal executed against the wrong account, or one the owner did not ask for — and it is approved on stricter terms than the ordinary restore in (a):

- **What is approved in addition.** (a) approves a restore. (d) approves a restore **and**, as a separate decision recorded separately, the reversal of a completed withdrawal. The second decision names the account being brought back and the evidence that the withdrawal was not what its owner asked for.
- **Who may approve.** (a) accepts any second person. (d) does not accept the operator who executed the withdrawal in either role, and the approver has to be someone acting on the account owner's own request rather than on an operator's account of it.
- **The window closes by itself, and closing is one-way.** Once the 30-day retention window passes there is nothing left to restore, and the withdrawal becomes irreversible with no further action by anyone. **An exception therefore has to be decided inside the window; deferring the decision is the same as denying it.**

The audit record is the one in (a), with the withdrawal-reversal decision written into its `reason` and `approver` rows.

## 12. Operating values

Every field of `DELIVERY_TUNING_DEFAULTS` (`packages/core/src/application/delivery/tuning.ts`) and `IDENTITY_TUNING_DEFAULTS` (`packages/core/src/application/identity/tuning.ts`), with what fixes it.

**Those two declarations are the source of truth; the tables below are a copy of them.** The limit that comes with the copy: **nothing compares the two mechanically.** Move a value in `tuning.ts` and this chapter goes stale in silence, so moving one means moving the other in the same change. The exceptions are the five declarations the queue consumers carry — `eventsMaxRetries`, `dlqMaxRetries`, `eventsMaxBatchTimeoutMs` and `eventsRetryDelayMs` against every request-Worker config, and `dlqRetentionMs` against the deploy templates' headers — and even there the test (`wranglerConfig.test.ts`) pins each declaration against `wrangler.toml` and the `.tpl` files, not against this document.

**These are settled, and four forms of reason recur — neither exhaustive nor disjoint** — a platform ceiling, a constraint `createDeliveryTuning` checks at construction, one past measurement (3.4 ms per 1,000 rows on a local Durable Object), and a copy of a value the wrangler config states. **A value that matches none of the four is a judgement made against the shape the machinery requires, and not a derivation**; the "What fixes it" column says which, one row at a time, and a row that gives a reason rather than a source is one of those judgements.

**No value here comes from a spike on a real workload.** All eleven `jobs.kind` handlers are registered (six on the User Data class, five on the Identity Directory class), so a spike is possible; none has been run on production-shaped data. **Tiers 1 and 2 of the three-tier job bound are what such a spike would revisit**; tier 3 is the bind ceiling and moves only with SQLite. The one local timing on record is the rotation chunk in chapter 3.

### 12.1 Delivery

| Field | Value | What fixes it |
| ----- | ----- | ------------- |
| `relayMaxRowsPerPass` | 25 | **a network bound, not a CPU one.** The relay publishes row by row with `send()` and never `sendBatch`, so this caps the round trips one pass makes, and it is held independently of the three job limits for that reason. **Its numeric agreement with the consumer's `max_batch_size` is a coincidence of choosing the same number, not a derivation** — a consumer batch size constrains what one consumer invocation receives and bounds nothing a producer claims |
| `relayLeaseMs` | 60,000 | comfortably longer than one publish round trip, short enough that a DO reset is recovered within a minute |
| `relayBackoffBaseMs` | 1,000 | one second is below the noise floor of a transient publish failure |
| `relayBackoffMaxDelayMs` | 300,000 | the cap, and **it never binds at `relayMaxAttempts` = 5** — from a 1 s base the delay reaches 300,000 ms only at attempt 9. It is there to bound the curve if the attempt count is ever raised |
| `relayMaxAttempts` | 5 | the delays actually taken are 2 s, 4 s, 8 s, 16 s, so a row reaches quarantine **≈ 30 s** after its first failed publish. Counted as the whole curve from attempt 0 — `1 + 2 + 4 + 8 + 16` — the run is 31 s. `createIdentityTuning` sums a curve of exactly this form, but it sums the **jobs** one; see 12.2 |
| `jobsMaxJobsPerPass` | 10 | tier 1 of the three-tier bound. **Derived, not measured**: 10 jobs × tier 2's 2,000 rows = 20,000 rows per wake-up ≈ 70 ms at the rate below, which sits well inside a Worker's CPU budget |
| `jobsMaxChunkIterations` | 20 | tier 2. **Derived, not measured**: 20 iterations × tier 3's 100 rows = 2,000 rows per job ≈ 7 ms, taken from the 3.4 ms per 1,000 rows measured during the move to Durable Objects |
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
| `listQuarantinedEventsLimit` | 50 | page size of the quarantine listing; keyset continuation (8.4) |
| `listPoisonedJobsLimit` | 50 | page size of the `poison` listing, matched to the quarantine one so an operator learns one paging discipline (8.5) |
| `deleteNoopReissueDelayMs` | 60,000 | how long a deletion job waits before re-issuing a round of `deleteMapping` that was a no-op over two generations (11.2). **A judgement, not a derivation**: the spec asks for "longer than the upper bound on a cross-DO RPC's lifetime", and no platform figure for that bound can be cited from this repository; one minute sits well above a Worker invocation's 30 s and above the 60 s leases here |

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
| **Per-origin rate limit** (paths, key, window) | a WAF rule, not this repository; see 9.4 | nothing yet — no rule exists ([#8](https://github.com/tuanemuy/fog/issues/8)) |

The throttle window and its grace are read: `IdentityTuning` holds `resetRequestWindowMs` (900,000) and `resetRequestWindowGraceMs` (300,000), the usecase composes `windowKey` from the first and the adapter computes the window row's `expires_at` from both — **one configured value, read by two layers from the same container**, which is what keeps `sweep-reset-tokens` from deleting a window that is still being counted against. The window length is held strictly below `resetTokenTtlMs` (900,000 < 3,600,000), as `spec/database/index.md` requires; `createIdentityTuning` checks its own fields, and that inequality is one of them. The export cap is `EXPORT_MAX_SOURCE_BYTES` (11.1).

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

**A Durable Object caps the total size of one query's result set.** The value comes from Cloudflare's published limits and is **not measurable from this repository**. The export path (11.1) is the one design that leans on it, and it bounds itself first — 24 MiB of body bytes, summed before any body is read — so the platform ceiling is never the first thing to bind.

### 12.7 Measured: occupancy of a shared bucket

**One `getResetMailMaterials` call**, which is the RPC a shared Identity Directory bucket serves on the delivery path.

| | |
| --- | --- |
| **Measured** | mean **0.68 ms** per call over 500 consecutive warm calls (total 342 ms); p50 and p95 both at the 1 ms measurement floor; slowest warm call 8 ms; first (cold) call 8 ms |
| **Conditions** | miniflare / workerd under `vitest.config.do.ts`, local machine, in-memory DO. One Identity Directory bucket seeded with 520 `published` rows; timed from the caller across the RPC boundary, so the figure includes the stub hop. Material source stubbed to return a live address, i.e. the `send` branch including the HMAC derivation |
| **Date** | 2026-08-24 |

**Limit — the per-call figures are at the instrument's floor.** workerd clamps timer resolution to 1 ms and advances clocks only at I/O boundaries, so p50 and p95 are the smallest observable value rather than measurements. **Only the aggregate is meaningful**, because it spans many I/O boundaries. This is a local, in-memory measurement and says nothing about production, where storage is real and the object is shared with concurrent callers.

**This is recorded as material, and no judgement is drawn from it.** The revisit condition it bears on lives in `spec/async/index.md` (P-001), whose "RPC round-trip cost" axis names exactly this kind of measurement as its material. **Applying the figure to that axis is still out of scope here** — the judgement belongs to whoever next revisits P-001.

## 13. What manual testing needs, and what exists

Enumerated from **every file under `spec/manual-tests/`** — `index.md`, `account.md`, `ai.md`, `document.md`, `search.md`, `settings.md`, `timeline.md`, `trash.md` — with duplicates folded across files. The list below is the union; it is not the delivery-focused subset that `account.md` alone would give.

| # | Capability | Required by | Reality |
| - | ---------- | ----------- | ------- |
| 1 | Seed memos with past posting dates directly into a DO | `timeline.md` (TC-03/07/08/24/25), `settings.md` (TC-03) | **Local only** — stop `pnpm dev`, edit `memos.posted_at` with `sqlite3` (chapter 6), restart. No write RPC exists for it |
| 2 | Seed trash rows whose `purge_after` is in the past | `trash.md` (TC-13/23/24) | **Local only** — the same `sqlite3` edit on `purge_after` |
| 3 | A development write RPC (the stated alternative to 1 and 2) | `timeline.md`, `settings.md` | **None, by design** — the AI test client (row 26) posts memos; dates are seeded as in row 1 |
| 4 | Move the clock backwards, or equivalent | `trash.md` (TC-13/24) | **None** — the clock is not moved; rows 2 and 5 stand in |
| 5 | Fire `purge-trash` without waiting for the Alarm | `trash.md` (TC-13/24) | **Local only** — pull the row's `next_run_at` into the past with `sqlite3` and re-arm the Alarm (any write through the maintenance surface re-arms; `requeue-poisoned-job` on a seeded row does too) |
| 6 | Fast-forward DO-side backoff / retry | `account.md` (TC-45/47) | **Local only** — edit `next_run_at` with `sqlite3`; the same for a seeded `terminal_reason` |
| 7 | Shorten the time the queue takes to burn its retries | `account.md` (TC-46) | **Local only** — edit `max_retries` in `wrangler.toml` and the matching declared value, then restart |
| 8 | Observe the Outbox backlog | `account.md` (TC-44) | **Available** — `read-delivery-backlog` (8.3) |
| 9 | `list-quarantined-events` | `account.md` (TC-45) | **Available** (8.4) |
| 10 | `requeue-quarantined-event` | `account.md` (TC-45) | **Available** (8.4) |
| 11 | `list-poisoned-jobs` | `account.md` (TC-47) | **Available** (8.5) |
| 12 | `requeue-poisoned-job` | `account.md` (TC-47) | **Available** (8.5) |
| 13 | Observe terminal mode (`status` runnable **and** `terminal_reason` set) | `account.md` (TC-47) | **Local only** — `sqlite3` on the `jobs` row; the listing shows `poison` rows only |
| 14 | Confirm a `poison` row survives the retention window | `account.md` (TC-47) | **Available** — `list-poisoned-jobs` after the window; the prune never touches `poison` |
| 15 | `read-schema-version`, to separate fail-closed from a real backlog | `account.md` (TC-44) | **Available** (8.3); locally also the diagnostic route (chapter 6) |
| 16 | List the DLQ's messages and read one | `account.md` (TC-46) | **None** — messages are re-driven once and acked (8.6); the log line is what remains |
| 17 | Re-drive from the DLQ | `account.md` (TC-46) | **Automatic, once** (8.6); there is no manual re-drive, by design |
| 18 | Break and restore the queue producer binding, to force quarantine | `account.md` (TC-45) | **Local only** — comment out `[[queues.producers]]` in `wrangler.state.toml` and restart, or seed a `quarantined` row with `sqlite3` |
| 19 | Break and restore the mail provider, to force a DLQ landing | `account.md` (TC-46) | **Local only** — unset `MAIL_DEV_SINK` without a provider key and the consumer fails; restore it afterwards |
| 20 | Open a throttle window (clear `reset_request_windows`) | `account.md` (TC-44/45/46) | **Local only** — `sqlite3` on the bucket's table |
| 21 | Fail a cross-DO RPC for one specific bucket | `account.md` (TC-47) | **Local only, and too coarse** — breaking `script_name` disables *all* DO calls, not one bucket; the terminal-mode entry itself is pinned by the integration suites; tracked in [#21](https://github.com/tuanemuy/fog/issues/21) |
| 22 | Receive mail (a development mailbox) | `account.md` (many), `timeline.md` | **Local only** — `MAIL_DEV_SINK="console"` prints `[dev-mail] to=… url=…` on the request Worker's log (the declared exception to the hygiene rule, `spec/async/index.md`); no deployed config carries it |
| 23 | Shorten the reset-token TTL | `account.md` (TC-30) | **Local only** — edit `resetTokenTtlMs`; there is no env override. **Editing it alone floors at 900,001 ms**, because constraint 1 (12.3) is checked at construction against `queueMaxRetryPeriodMs + dlqRetentionMs`; lowering those two as well — to 90,000 (their own floor) and 0 — takes the TTL down to 90,001 ms. Below that `createDeliveryTuning` throws `CONFIGURATION_ERROR` and the container never builds. Alternatively, `sqlite3` on `password_reset_tokens.expires_at` |
| 24 | Produce an expired authorization URL | `account.md` (TC-25) | **Local only** — the AI test client (row 26) prints the URL; wait out the code's TTL before opening it |
| 25 | Read and adjust the lockout settings | `account.md` (TC-40) | **Local only** — edit `IDENTITY_TUNING_DEFAULTS`; there is no env override |
| 26 | A real MCP-capable AI client connected to the app | `ai.md` (all), `account.md`, `timeline.md`, `document.md` | **Available as a test client** — `pnpm --filter @repo/web ai-client -- register / authorize / mcp <method> / call <tool>` runs the OAuth 2.1 round trip against a loopback redirect and speaks MCP and REST; a real LLM application is **None** (no credentials, out of the spec's scope) |
| 27 | Call the REST API directly with `curl` under an AI token | `ai.md` | **Available** — the test client's `call` does exactly that; `whoami` shows the state file without its secrets |
| 28 | Read the AI client's tool-execution log | `ai.md` | **Available** — the test client prints each call and its answer |
| 29 | Two real Google accounts and a registered OAuth client | `account.md` (SSO cases) | **Local only** — `SSO_DEV_STUB="true"` serves `/__dev/sso/:provider/authorize`, which takes a subject and an email and bounces back with a code; any two subjects are two accounts. Real Google needs `GOOGLE_CLIENT_ID` / `_SECRET` and is unverified here; Apple has no real adapter |
| 30 | A Google account sharing an address with a password account | `account.md` (TC-18) | **Local only** — the stub takes any email |
| 31 | A second browser session (private window / second browser) | `account.md`, `timeline.md`, `document.md`, `trash.md`, `search.md`, `settings.md` | **Available** |
| 32 | Throttle the network from devtools (Offline / Slow 3G) | `timeline.md` (TC-17/18) | **Available** |
| 33 | Bulk-post 51+ memos | `timeline.md` (TC-04), `search.md` (TC-22) | **Available** — the UI, or the test client's `call post_memo` in a loop |
| 34 | Generate long text locally and save it to a file | `timeline.md`, `document.md`, `ai.md`, `search.md` | **Available** |
| 35 | Unzip an archive and inspect it with `find` / `grep` | `settings.md` (TC-03/04/05/06/11) | **Available** — the export (11.1). **macOS's bundled `unzip` fails on the archive's non-ASCII entry names**; the archive is correct (UTF-8 flag set), and Python's `zipfile`, `ditto -x -k` or Finder extract it |
| 36 | Set the browser timezone to `Asia/Tokyo` | `settings.md` | **Available** |
| 37 | A second, empty user account | `settings.md`, `timeline.md`, `document.md`, `trash.md` | **Available** — sign-up works |
| 38 | Run SQL against a database shared by all users | `timeline.md` names it as *not existing* | **None, by design** — every user's data is inside their own DO |

**Three things about running these tests that are easy to get wrong:**

- **There is no shared database to reach for** (row 38). Data is per-DO by construction; locally it is one SQLite file per object (chapter 6), and a file can only be read while `pnpm dev` is stopped.
- **Fast-forwarding the DO does not advance the queue** (rows 6 and 7 are different capabilities). The queue's redelivery interval and `max_retries` are platform settings; no amount of poking the Alarm moves them. Observing a retry burn-through needs a separate queue configured with a smaller `max_retries`.
- **Delivery is asynchronous and at-least-once.** Expect to wait, and expect the same email more than once. **A duplicate is not a bug** — a test that fails on the second copy is testing the wrong thing.

## 14. Known limits

Each row is described in full in the section it names, and tracked on its issue.

| Limit | Described in | Tracked in |
| ----- | ------------ | ---------- |
| The request Worker cannot be deployed, and `pnpm start` does not boot, for the same cause | 4.2, `README.md` | [#3](https://github.com/tuanemuy/fog/issues/3) |
| The Pulumi `resources` stack still provisions a D1 database, and the render script still substitutes its two placeholders, with no runtime reader | chapter 1, chapter 2 (Pulumi) | [#4](https://github.com/tuanemuy/fog/issues/4) |
| **The DLQ's one log line is not retained in production** — no wrangler config declares `[observability]`, so Workers Logs is off and only a live `wrangler tail` sees it | 8.6, 8.7 | [#5](https://github.com/tuanemuy/fog/issues/5) |
| PITR's four mandatory steps have no maintenance entry; in production they cannot be executed | 11.3 | [#6](https://github.com/tuanemuy/fog/issues/6) |
| Stuck delivery is not actively notified | 7.3, 8.3 | [#7](https://github.com/tuanemuy/fog/issues/7) |
| No per-origin rate limiting | 9.4 | [#8](https://github.com/tuanemuy/fog/issues/8) |
| A cross-DO RPC cannot be failed for one bucket locally (manual test `account.md` TC-47) | 13 (row 21) | [#21](https://github.com/tuanemuy/fog/issues/21) |
| **Individual operators cannot be told apart by the surface itself.** `OPERATOR_TOKEN` is one bearer; identity comes from Cloudflare Access in front of it (8.2), which this repository does not configure | 8.2 | operations — Access is the control |
| The three out-of-band settings (DLQ retention, queue retry period, WAF) cannot be read back from the repository | chapter 5 | inherent, not scheduled |
