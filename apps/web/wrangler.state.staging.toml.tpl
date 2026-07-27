name = "${RESOURCE_PREFIX}-state"
main = "app/server.state.ts"
compatibility_date = "2026-07-04"
compatibility_flags = ["nodejs_compat"]

[secrets]
required = ["IDENTITY_MAIL_ENCRYPTION_KEY"]

[[services]]
binding = "IDENTITY_MAIL_PROVIDER"
service = "${RESOURCE_PREFIX}-identity-mail-provider"

[[durable_objects.bindings]]
name = "USER_DATA"
class_name = "UserDataDurableObject"

[[durable_objects.bindings]]
name = "IDENTITY_DIRECTORY"
class_name = "IdentityDirectoryDurableObject"

[[durable_objects.bindings]]
name = "ACCOUNT_HOME"
class_name = "AccountHomeDurableObject"

[exports.UserDataDurableObject]
type = "durable-object"
storage = "sqlite"

[exports.IdentityDirectoryDurableObject]
type = "durable-object"
storage = "sqlite"

[exports.AccountHomeDurableObject]
type = "durable-object"
storage = "sqlite"
