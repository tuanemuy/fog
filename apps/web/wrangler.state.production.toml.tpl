# Production deploy config TEMPLATE for the **state Worker** — rendered to
# `wrangler.state.production.toml` by `pnpm cf:render:production`. Both files
# come from the same Pulumi outputs, which is what keeps `name` here and
# `script_name` in the request config from drifting apart.
#
# **Deploy this Worker before the request Worker.** The DO bindings over
# there name this script, and a binding cannot be created against a script
# that does not exist yet.
name = "${RESOURCE_PREFIX}-state"
main = "app/worker/cloudflare/state.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserDataDurableObject", "IdentityDirectoryDurableObject"]

# Self-referencing namespaces for the saga jobs that call the other class
# from inside `alarm()`. No `script_name`: these point at this Worker.
[[durable_objects.bindings]]
name = "USER_DATA"
class_name = "UserDataDurableObject"

[[durable_objects.bindings]]
name = "IDENTITY_DIRECTORY"
class_name = "IdentityDirectoryDurableObject"

# The relay publishes from inside `alarm()`, so the producer binding is
# here rather than on the request Worker.
[[queues.producers]]
binding = "EVENTS_QUEUE"
queue = "${EVENTS_QUEUE_NAME}"
