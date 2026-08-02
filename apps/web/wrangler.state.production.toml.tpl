# Production deploy config TEMPLATE for the **state Worker** (the Durable Object
# host) — rendered to `wrangler.state.production.toml` by
# `pnpm cf:render:production`.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.state.production.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Before first deploy =================================================
#   1. `pulumi -C infra/cloudflare/pulumi/resources -s production up`
#   2. `pnpm cf:render:production`
#   3. `wrangler secret put <NAME> --config wrangler.state.production.toml`
#      (state side: IDENTITY_MAIL_ENCRYPTION_KEY / IDENTITY_RESET_TOKEN_KEY —
#       see `apps/web/.dev.vars.example`; the request side's secrets must not
#       be set here)
#   4. `pnpm deploy:state:production` — this Worker deploys **before** the
#      request Worker, whose DO bindings name this script
# =========================================================================
name = "${RESOURCE_PREFIX}-state"
main = "dist/state/index.js"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[vars]
APP_URL = "${APP_URL}"

# Declarative Durable Object class lifecycle; mutually exclusive with the
# `[[migrations]]` array. `storage = "sqlite"` is what backs `ctx.storage.sql`.
# One-way door: a namespace deployed through `exports` cannot be moved back.
[exports.UserDataDurableObject]
type = "durable-object"
storage = "sqlite"

[exports.IdentityDirectoryDurableObject]
type = "durable-object"
storage = "sqlite"

# DO-to-DO RPC from inside the state Worker: self-bindings, hence no
# `script_name`.
[[durable_objects.bindings]]
name = "USER_DATA"
class_name = "UserDataDurableObject"

[[durable_objects.bindings]]
name = "IDENTITY_DIRECTORY"
class_name = "IdentityDirectoryDurableObject"
