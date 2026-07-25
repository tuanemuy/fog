import { Skeleton } from "@/components/ui/Skeleton";

const ROW = "flex items-center justify-between gap-md py-(--pad-row)";
const BAR = "h-(--skeleton-line-h) w-full max-w-(--skeleton-line-w-short)";

/**
 * Streaming placeholder for `CurrentUserPanel`, shaped like the real DOM
 * (section label + two rows + the logout button) so the panel swaps in
 * without shifting the layout.
 */
export function SettingsSkeleton() {
  return (
    <section role="status" aria-live="polite">
      <span className="sr-only">読み込み中</span>
      <Skeleton className={`mb-sm ${BAR}`} />
      <div className={ROW}>
        <Skeleton className={BAR} />
        <Skeleton className={BAR} />
      </div>
      <div className={`${ROW} border-t border-neutral-100`}>
        <Skeleton className={BAR} />
        <Skeleton className={BAR} />
      </div>
      <div className="border-t border-neutral-100 pt-lg">
        <Skeleton className="h-(--skeleton-title-h) w-(--skeleton-line-w-short)" />
      </div>
    </section>
  );
}
