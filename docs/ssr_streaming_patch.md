# SSR streaming dependency patch

`@tanstack/react-router` and `@tanstack/router-core` are pinned to `1.169.2`. `pnpm-workspace.yaml` applies [the router-core patch](../patches/@tanstack__router-core@1.169.2.patch) during installation.

The unpatched router can finish serializing a deferred loader value after React renders `<Scripts />` but before the HTML stream transform starts. Its passthrough path then drops the queued settlement scripts and Flight payload. The page renders on the server, while its client islands never hydrate.

The patch keeps queued scripts out of that passthrough path, listens for their injection, and flushes them before closing the document. It changes the package source, ESM, CJS, and type declarations. Route loaders still return deferred RSC promises and stream under Suspense.

The [upstream SSR implementation](https://github.com/TanStack/router/blob/main/packages/router-core/src/ssr/ssr-server.ts) checks pending scripts before reserving its stream fast path and flushes at render completion. This patch backports those safeguards to the installed version without upgrading the surrounding router APIs.

Install with `pnpm install --frozen-lockfile`. Run the regression with:

```bash
pnpm exec vitest run apps/web/app/presentation/fogSsrStreaming.test.ts
```

The regression covers settlement before and after the HTML transform starts. It asserts early HTML delivery for a pending promise and settlement before `</body>`. When upgrading TanStack, remove the pin and patch only after this test and direct-URL RSC interaction both pass with the replacement version.
