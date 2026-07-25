import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Generic route-level pending UI, wired as the router's
 * `defaultPendingComponent` for loaders unresolved past `defaultPendingMs`.
 *
 * Streaming routes are not exempt: on client navigation their loader still
 * pays the `/_serverFn/...` round trip that hands over the RSC promise, so
 * a slow hop shows this first and the fragment skeleton after.
 *
 * `role="status"` + `aria-live="polite"` + the sr-only label give one polite
 * announcement for the region; the bars are `aria-hidden` via `Skeleton`.
 */
export function RoutePendingFallback() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-md p-lg">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-skeleton-title w-skeleton-short" />
      <Skeleton className="h-skeleton-line w-full max-w-content" />
      <Skeleton className="h-skeleton-line w-full max-w-content" />
      <Skeleton className="h-skeleton-line w-full max-w-skeleton-short" />
    </div>
  );
}
