# Staging deploy config TEMPLATE for the **request Worker** — rendered to
# `wrangler.request.staging.toml` by `pnpm cf:render:staging`, which substitutes
# `${...}` placeholders with outputs from the `fog-cf-resources/staging` stack.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.request.staging.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Before first deploy =================================================
#   1. `pulumi -C infra/cloudflare/pulumi/resources -s staging up`
#   2. `pnpm cf:render:staging`
#   3. `wrangler secret put <NAME> --config wrangler.request.staging.toml`
#      (request side: SESSION_SECRET / AI_CLIENT_TOKEN_SECRET /
#       DIRECTORY_ROUTING_SECRET — see `apps/web/.dev.vars.example`)
#   4. `pnpm deploy:staging` (state Worker first, then this one — the DO
#      bindings below name a script that must already exist)
#   5. `pulumi -C infra/cloudflare/pulumi/routes -s staging up`
# =========================================================================
name = "${RESOURCE_PREFIX}"
# Build output: wrangler reads this file directly, with no vite plugin in the
# path to resolve `main` for it.
main = "dist/server/index.js"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist/client"
binding = "ASSETS"

[vars]
APP_URL = "${APP_URL}"

[[durable_objects.bindings]]
name = "USER_DATA"
class_name = "UserDataDurableObject"
script_name = "${RESOURCE_PREFIX}-state"

[[durable_objects.bindings]]
name = "IDENTITY_DIRECTORY"
class_name = "IdentityDirectoryDurableObject"
script_name = "${RESOURCE_PREFIX}-state"
