# Production deploy config TEMPLATE for the **request Worker** — rendered to
# `wrangler.production.toml` by `pnpm cf:render:production`, which substitutes
# `${...}` placeholders with outputs from the `cf-resources/production`
# Pulumi stack.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.production.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Deploying ===========================================================
# `.github/workflows/deploy-production.yml` runs these steps on every `v*.*.*` tag, once the `production`
# environment's reviewers approve
# (docs/runtime_cloudflare.md, chapter 4). By hand — the first bootstrap,
# or when the workflow cannot run — they are:
#   1. `pnpm secrets:check production` decrypts
#      `secrets/production.request.enc.json` / `secrets/production.state.enc.json`
#      and checks them against the roster in `.dev.vars.example`.
#   2. `pulumi -C infra/cloudflare/pulumi/resources -s production up`
#   3. `pnpm cf:render:production` (renders BOTH request and state configs)
#      `${MAIL_FROM_ADDRESS}` is read from the MAIL_FROM_ADDRESS environment
#      variable at render time (it is not a Pulumi output): export it first.
#   4. **Deploy the state Worker first**, then the request Worker: the
#      `script_name` below must already exist for the DO bindings to bind.
#      `pnpm deploy:production:all` builds the stage, then runs the two in that
#      order. **`wrangler deploy` is never pointed at the rendered file**: `main`
#      below is the TanStack Start source entry, whose virtual modules
#      (`#tanstack-start-entry`, `#tanstack-router-entry`,
#      `tanstack-start-manifest:v`) only the Vite plugin supplies. The
#      stage build (`vite.config.cloudflare.production.ts`) reads this file
#      and writes `dist/server/wrangler.json`, and that output is what
#      `pnpm deploy:production` hands to `wrangler deploy`, once
#      `scripts/deploy-built.ts` has checked it was built from this stage.
#   5. `pnpm secrets:push production` uploads each file against its own
#      Worker's config, then compares the secrets each Worker holds with
#      its file. Without the encrypted files, one secret at a time:
#      `wrangler secret put SESSION_SECRET --config wrangler.production.toml`
#      `wrangler secret put MAIL_PROVIDER_API_KEY --config wrangler.production.toml`
#      `wrangler secret put DIRECTORY_ROUTING_SECRET --config wrangler.production.toml`
#      `wrangler secret put AI_CLIENT_TOKEN_SECRET --config wrangler.production.toml`
#      `wrangler secret put OPERATOR_TOKEN --config wrangler.production.toml`
#      `wrangler secret put GOOGLE_CLIENT_ID --config wrangler.production.toml`
#      `wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.production.toml`
#      `wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEY --config wrangler.state.production.toml`
#      `wrangler secret put PROVIDER_IDEMPOTENCY_KEY --config wrangler.state.production.toml`
#      `wrangler secret put IDENTITY_RESET_TOKEN_KEY --config wrangler.state.production.toml`
#      The last three belong to the **state** Worker. Without the encryption
#      key the Identity Directory throws on the first reservation and no
#      registration completes at all.
#      Only while a key is being rotated (`spec/rotation/index.md`; deployed
#      as a pair, request + state, and deleted again after retirement):
#      `wrangler secret put DIRECTORY_ROUTING_KEYRING --config wrangler.production.toml`
#      `wrangler secret put DIRECTORY_KEY_COMMITMENT --config wrangler.state.production.toml`
#      `wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEYRING --config wrangler.state.production.toml`
#      These commands only read the Worker's name, so they take this file.
#   6. Set the DLQ's retention out of band — it is a Queue-resource
#      setting, not a wrangler key:
#      `wrangler queues update ${DLQ_QUEUE_NAME} --message-retention-period-secs 600`
#   7. `pulumi -C infra/cloudflare/pulumi/routes -s production up`
# =========================================================================
name = "${RESOURCE_PREFIX}"
main = "app/server.cloudflare.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist/client"
binding = "ASSETS"

# `DIAGNOSTICS_ENABLED` is deliberately absent: the diagnostic route is a
# local / preview affordance and is registered in no deployed stage.
[vars]
APP_URL = "${APP_URL}"
# The sender the mail provider is asked to use; `MAIL_DEV_SINK` and
# `SSO_DEV_STUB` are deliberately absent, so no deployed stage can select
# the development sink or the stub identity provider.
MAIL_FROM_ADDRESS = "${MAIL_FROM_ADDRESS}"


[[durable_objects.bindings]]
name = "USER_DATA"
class_name = "UserDataDurableObject"
script_name = "${RESOURCE_PREFIX}-state"

[[durable_objects.bindings]]
name = "IDENTITY_DIRECTORY"
class_name = "IdentityDirectoryDurableObject"
script_name = "${RESOURCE_PREFIX}-state"

# Mail consumer. `max_retries` + `dead_letter_queue` mirror the declared
# values in `application/delivery/tuning.ts`.
[[queues.consumers]]
queue = "${EVENTS_QUEUE_NAME}"
max_batch_size = 25
max_batch_timeout = 30 # seconds
max_retries = 3
dead_letter_queue = "${DLQ_QUEUE_NAME}"

# DLQ handler. No dead-letter target of its own — a re-failure would loop.
[[queues.consumers]]
queue = "${DLQ_QUEUE_NAME}"
max_batch_size = 25
max_batch_timeout = 30 # seconds
max_retries = 1
