import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Generic, route-level navigation pending UI.
 *
 * Wired as the router's `defaultPendingComponent`: shown while a route whose
 * loader genuinely blocks resolves (past `defaultPendingMs`). Routes that
 * stream their own content via `<Suspense>` (e.g. `/todo`) settle their loader
 * instantly and never trigger this — they rely on a per-fragment skeleton
 * instead.
 *
 * `role="status"` + `aria-live="polite"` + the sr-only label give one polite
 * announcement for the whole region; the bars are `aria-hidden` via `Skeleton`.
 * It holds no padding or width of its own: the frame it is drawn in does.
 */
export function RoutePendingFallback() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-md">
      <span className="sr-only">読み込み中</span>
      <Skeleton className="h-xl w-1/3" />
      <Skeleton className="h-md w-full" />
      <Skeleton className="h-md w-5/6" />
      <Skeleton className="h-md w-2/3" />
    </div>
  );
}
