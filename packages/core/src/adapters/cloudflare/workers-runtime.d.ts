// Loads the workerd global type declarations so this package can see the
// `cloudflare:workers` module the Durable Object base class extends.
// `packages/core/tsconfig.json` pins `types` to `node`, and importing
// `@cloudflare/workers-types` by name resolves to its module entry, which
// carries the interfaces but not the ambient module declaration.
/// <reference types="@cloudflare/workers-types" />
