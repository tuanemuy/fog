import { Skeleton } from "@/components/ui/Skeleton";

/** Shaped to `CurrentUserPanel`: six headed sections with one row each. */
export function SettingsSkeleton() {
  return (
    <div className="fog-settings" role="status" aria-live="polite">
      <span className="fog-sr-only">読み込み中</span>
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <section key={n} aria-hidden="true" className="flex flex-col gap-md">
          <Skeleton className="h-md w-1/4" />
          <Skeleton className="h-md w-full max-w-narrow" />
        </section>
      ))}
    </div>
  );
}
