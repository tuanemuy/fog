# Production deploy config TEMPLATE — rendered to `wrangler.production.toml`
# by `pnpm cf:render:production`, which substitutes `${...}`
# placeholders with outputs from the `cf-resources/production` Pulumi stack.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.production.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Before first deploy =================================================
#   1. `pulumi -C infra/cloudflare/pulumi/resources -s production up`
#   2. `pnpm cf:render:production`
#   3. `wrangler secret put <NAME> --config wrangler.production.toml`
#   4. `wrangler deploy -c wrangler.production.toml`
#   5. `pulumi -C infra/cloudflare/pulumi/routes -s production up`
# =========================================================================
name = "${RESOURCE_PREFIX}"
main = "app/server.cloudflare.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist/client"
binding = "ASSETS"

[vars]
APP_URL = "${APP_URL}"

[[d1_databases]]
binding = "DB"
database_name = "${D1_DATABASE_NAME}"
database_id = "${D1_DATABASE_ID}"
migrations_dir = "../../packages/core/src/adapters/d1/migrations"
