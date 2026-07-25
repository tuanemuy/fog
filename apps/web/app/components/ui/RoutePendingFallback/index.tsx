import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Generic, route-level navigation pending UI.
 *
 * Wired as the router's `defaultPendingComponent`: shown while a route whose
 * loader genuinely blocks resolves (past `defaultPendingMs`). Routes that
 * stream their own content via `<Suspense>` settle their loader instantly and
 * never trigger this — they rely on a per-fragment skeleton instead.
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
