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
# Ship the build exactly as vite produced it. `deploy:request:*` passes `-c`,
# which takes wrangler off the `.wrangler/deploy/config.json` redirect and
# therefore away from the `dist/server/wrangler.json` the framework generates
# — including its `no_bundle` / `rules`. Without these two, wrangler re-bundles
# every emitted ES module into one file, i.e. deploys a differently-shaped
# artifact than the one `pnpm start` and the smoke test boot. Verify after a
# change: `pnpm build:cf`, then compare `wrangler deploy -c <rendered file>
# --dry-run` with the redirect route (`wrangler deploy --dry-run`, no `-c`) —
# the module count and total upload size must match. Those absolute numbers
# move with every build, so they belong in the PR, not in this file.
no_bundle = true
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# Mirrors the generated config's rule: every emitted `.js` under `dist/server`
# (`assets/*.js`, `rsc/index.js`) is an ES module, and `no_bundle` only picks
# up what a rule matches.
[[rules]]
type = "ESModule"
globs = ["**/*.js", "**/*.mjs"]

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
