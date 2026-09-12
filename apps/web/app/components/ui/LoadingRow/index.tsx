import type { Ref } from "react";
import { Icon } from "@/components/ui/Icon";

export type LoadingRowProps = Readonly<{
  /**
   * What is being loaded, announced once as a status. `null` keeps the row
   * mounted and empty: a live region that appears together with its first
   * message is often not read, so a list that watches this row as its
   * sentinel draws it before the load starts.
   */
  label: string | null;
  /** The sentinel an endless list watches where this row sits, if it has one. */
  ref?: Ref<HTMLDivElement>;
}>;

/**
 * The line that holds the place of what is loading below a list
 * (`.loading-more` in `spec/design/pages/search.html`, the same form as
 * `timeline.html`'s): the spinner and one label, centred, with the space that
 * separates it from the list above. Every screen that loads a next page reads
 * this one — a failure in its place is the screen's own (`EmptyState` with a
 * retry, `InlineAlert`), because what can be pressed differs per screen.
 */
export function LoadingRow({ label, ref }: LoadingRowProps) {
  return (
    <div
      ref={ref}
      role="status"
      className="flex items-center justify-center gap-sm pt-lg pb-sm font-base text-xs font-medium leading-tight tracking-label text-neutral-400"
    >
      {label === null ? null : (
        <>
          <Icon name="spinner" size="xs" />
          {label}
        </>
      )}
    </div>
  );
}
