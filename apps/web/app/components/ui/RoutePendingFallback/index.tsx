import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Generic, route-level navigation pending UI.
 *
 * Wired as the router's `defaultPendingComponent`: shown while a route whose
 * loader stays unresolved past `defaultPendingMs` resolves.
 *
 * A streaming route (`routes/_app/settings.tsx`) leans on a per-fragment
 * skeleton instead, but it is not exempt: its loader still awaits the
 * `createServerFn` call that hands over the unresolved RSC promise. That
 * await is free under SSR (same process) and on client navigation costs one
 * `/_serverFn/...` round trip, so a hop slower than `defaultPendingMs` shows
 * this first and the fragment skeleton after. Measured at 253ms with 1500ms
 * injected into the handler.
 *
 * `role="status"` + `aria-live="polite"` + the sr-only label give one polite
 * announcement for the whole region; the bars are `aria-hidden` via `Skeleton`.
 */
export function RoutePendingFallback() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-md p-lg">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-(--skeleton-title-h) w-(--skeleton-line-w-short)" />
      <Skeleton className="h-(--skeleton-line-h) w-full max-w-(--content-max)" />
      <Skeleton className="h-(--skeleton-line-h) w-full max-w-(--content-max)" />
      <Skeleton className="h-(--skeleton-line-h) w-full max-w-(--skeleton-line-w-short)" />
    </div>
  );
}
