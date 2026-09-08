# Production deploy config TEMPLATE for the **request Worker** — rendered to
# `wrangler.production.toml` by `pnpm cf:render:production`, which substitutes
# `${...}` placeholders with outputs from the `cf-resources/production`
# Pulumi stack.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.production.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Before first deploy =================================================
#   1. `pulumi -C infra/cloudflare/pulumi/resources -s production up`
#   2. `pnpm cf:render:production` (renders BOTH request and state configs)
#      `${MAIL_FROM_ADDRESS}` is read from the MAIL_FROM_ADDRESS environment
#      variable at render time (it is not a Pulumi output): export it first.
#   3. `wrangler secret put SESSION_SECRET --config wrangler.production.toml`
#      `wrangler secret put MAIL_PROVIDER_API_KEY --config wrangler.production.toml`
#      `wrangler secret put DIRECTORY_ROUTING_SECRET --config wrangler.production.toml`
#      `wrangler secret put PROVIDER_IDEMPOTENCY_KEY --config wrangler.state.production.toml`
#      `wrangler secret put IDENTITY_MAIL_ENCRYPTION_KEY --config wrangler.state.production.toml`
#      The last two belong to the **state** Worker. Without the encryption
#      key the Identity Directory throws on the first reservation and no
#      registration completes at all.
#   4. Set the DLQ's retention out of band — it is a Queue-resource
#      setting, not a wrangler key:
#      `wrangler queues update ${DLQ_QUEUE_NAME} --message-retention-period-secs 600`
#   5. **Deploy the state Worker first**, then the request Worker: the
#      `script_name` below must already exist for the DO bindings to bind.
#      `pnpm deploy:production:all` runs the two in that order, but only its
#      first half lands today. `pnpm deploy:production:state` deploys the
#      state Worker; the request half (`pnpm deploy:production`) fails while
#      bundling, because `main` below is the TanStack Start source entry and
#      `wrangler deploy` cannot resolve its virtual modules
#      (`#tanstack-start-entry`, `#tanstack-router-entry`,
#      `tanstack-start-manifest:v`) — the same unresolved point that keeps
#      `pnpm start` from booting. Tracking: #73.
#   6. `pulumi -C infra/cloudflare/pulumi/routes -s production up`
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
