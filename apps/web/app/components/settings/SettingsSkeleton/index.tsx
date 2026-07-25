import { Skeleton } from "@/components/ui/Skeleton";

const ROW = "flex items-center justify-between gap-md py-row";
const BAR = "h-skeleton-line w-full max-w-skeleton-short";

/**
 * Streaming placeholder for `CurrentUserPanel`, shaped like the real DOM
 * (section label + two rows + the logout button) so the panel swaps in
 * without shifting the layout. The spacing must be kept in step with
 * `CurrentUserPanel` — including how it is carried (the leading row's
 * `mt-sm`, not a margin under the label).
 */
export function SettingsSkeleton() {
  return (
    <section role="status" aria-live="polite">
      <span className="sr-only">読み込み中</span>
      <Skeleton className={BAR} />
      <div className={`${ROW} mt-sm`}>
        <Skeleton className={BAR} />
        <Skeleton className={BAR} />
      </div>
      <div className={`${ROW} border-t border-neutral-100`}>
        <Skeleton className={BAR} />
        <Skeleton className={BAR} />
      </div>
      <div className="border-t border-neutral-100 pt-lg">
        <Skeleton className="h-skeleton-title w-skeleton-short" />
      </div>
    </section>
  );
}
