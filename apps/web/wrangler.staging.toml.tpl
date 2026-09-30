# Staging deploy config TEMPLATE for the **request Worker** — rendered to
# `wrangler.staging.toml` by `pnpm cf:render:staging`, which substitutes
# `${...}` placeholders with outputs from the `cf-resources/staging`
# Pulumi stack.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.staging.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Deploying ===========================================================
# `.github/workflows/deploy-staging.yml` runs these steps on every push to `main`
# (docs/runtime_cloudflare.md 4.1 and 4.2, numbered the same). By hand —
# the first bootstrap, or when the workflow cannot run — they are:
#   1. `pnpm secrets:check staging` decrypts
#      `secrets/staging.request.enc.json` / `secrets/staging.state.enc.json`
#      and checks them against the roster in `.dev.vars.example`.
#   2. `pulumi -C infra/cloudflare/pulumi/resources -s staging up`
#   3. `pnpm cf:render:staging` (renders BOTH request and state configs)
#      `${MAIL_FROM_ADDRESS}` is read from the MAIL_FROM_ADDRESS environment
#      variable at render time (it is not a Pulumi output): export it first.
#   4. Set the DLQ's retention out of band — it is a Queue-resource
#      setting, not a wrangler key:
#      `wrangler queues update ${DLQ_QUEUE_NAME} --message-retention-period-secs 600`
#   5. **Deploy the state Worker first**, then the request Worker: the
#      `script_name` below must already exist for the DO bindings to bind.
#      `pnpm deploy:staging:all` builds the stage, then runs the two in that
#      order. **`wrangler deploy` is never pointed at the rendered file**: `main`
#      below is the TanStack Start source entry, whose virtual modules
#      (`#tanstack-start-entry`, `#tanstack-router-entry`,
#      `tanstack-start-manifest:v`) only the Vite plugin supplies. The
#      stage build (`vite.config.cloudflare.staging.ts`) reads this file
#      and writes `dist/server/wrangler.json`, and that output is what
#      `pnpm deploy:staging` hands to `wrangler deploy`, once
#      `scripts/deploy-built.ts` has checked it was built from this stage.
#   6. `pnpm secrets:push staging` uploads each file against its own
#      Worker's config, confirms each upload, then compares the secrets each
#      Worker holds with its file. Without the encrypted files, one secret at a time:
#      `wrangler secret put SESSION_SECRET --config wrangler.staging.toml`
#      `wrangler secret put MAIL_PROVIDER_API_KEY --config wrangler.staging.toml`
#      `wrangler secret put DIRECTORY_ROUTING_SECRET --config wrangler.staging.toml`
#      `wrangler secret put AI_CLIENT_TOKEN_SECRET --config wrangler.staging.toml`
#      `wrangler secret put OPERATOR_TOKEN --config wrangler.staging.toml`
#      `wrangler secret put GOOGLE_CLIENT_ID --config wrangler.staging.toml`
#      `wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.staging.toml`
#      `wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEY --config wrangler.state.staging.toml`
#      `wrangler secret put PROVIDER_IDEMPOTENCY_KEY --config wrangler.state.staging.toml`
#      `wrangler secret put IDENTITY_RESET_TOKEN_KEY --config wrangler.state.staging.toml`
#      The last three belong to the **state** Worker. Without the encryption
#      key the Identity Directory throws on the first reservation and no
#      registration completes at all.
#      Only while a key is being rotated (`spec/rotation/index.md`; deployed
#      as a pair, request + state, and deleted again after retirement):
#      `wrangler secret put DIRECTORY_ROUTING_KEYRING --config wrangler.staging.toml`
#      `wrangler secret put DIRECTORY_KEY_COMMITMENT --config wrangler.state.staging.toml`
#      `wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEYRING --config wrangler.state.staging.toml`
#      These commands only read the Worker's name, so they take this file.
#   7. `pulumi -C infra/cloudflare/pulumi/routes -s staging up`
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
