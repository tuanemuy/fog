import { Skeleton } from "@/components/ui/Skeleton";

/** Shaped to `CurrentUserPanel`: six headed sections with one row each. */
export function SettingsSkeleton() {
  return (
    <div className="fog-content fog-settings" role="status" aria-live="polite">
      <span className="fog-sr-only">読み込み中</span>
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <section key={n} aria-hidden="true">
          <Skeleton className="h-4 w-32 mb-3" />
          <Skeleton className="h-4 w-full max-w-md" />
        </section>
      ))}
    </div>
  );
}
