/**
 * Options shared by every route whose loader forwards an unresolved
 * `renderServerComponent(...)` promise (per-fragment streaming).
 *
 * `ssr` is off under `vite dev` only: there, an SSR response that carries an
 * RSC payload never emits `$_TSR.e()` (the stream end), so the streamed leaf
 * stays unhydrated and its client islands never become interactive. The
 * production build (`pnpm build && pnpm preview`) streams and hydrates
 * correctly — this is an upstream TanStack Start / vite-plugin issue in dev,
 * not a property of the routes. With `ssr: false` the loader runs on the
 * client through the same server function, so the skeleton → content flow is
 * unchanged. Limit: browser checks under `pnpm dev` therefore do not cover
 * the SSR streaming path; verify that on the preview build.
 *
 * `pendingComponent: () => null` leaves the fragment skeleton as the only
 * fallback (CLAUDE.md, "Loading fallbacks").
 */
export const streamingRouteOptions = {
  ssr: !import.meta.env.DEV,
  pendingComponent: () => null,
} as const;
