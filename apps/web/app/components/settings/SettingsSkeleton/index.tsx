import { Skeleton } from "@/components/ui/Skeleton";

const ROW = "flex items-center justify-between gap-md py-row";
const BAR = "h-skeleton-line w-full max-w-skeleton-short";

/**
 * Streaming placeholder for `CurrentUserPanel`, shaped like the real DOM
 * (section label + one credential row) so the panel swaps in without shifting
 * the layout. The spacing must be kept in step with `CurrentUserPanel` —
 * including how it is carried (the leading row's `mt-sm`, not a margin under
 * the label).
 *
 * One row, because every account this issue can create holds exactly one
 * login credential (`registerWithPassword` records the email one and nothing
 * else). Revisit together with the multi-credential list in #12.
 *
 * The sign-out affordance is deliberately absent: it renders outside the
 * streamed fragment (`routes/_app/settings.tsx`), so it is already on screen
 * while this placeholder shows.
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
    </section>
  );
}
