import type { ReactNode } from "react";

/**
 * - `item` — a top-level row
 * - `nested` — a row that belongs to the item above it, indented and set
 *   smaller (a topic's documents under the topic in the trash)
 */
export type RowLevel = "item" | "nested";

export type RowProps = Readonly<{
  /** The row's own text: title, then its meta line. */
  children: ReactNode;
  /** The row's independent controls — `IconButton`s or a `Button`. */
  actions?: ReactNode;
  /**
   * The failure of this row's last action, drawn under the row across its
   * full width rather than squeezed into the text column.
   */
  error?: ReactNode;
  level?: RowLevel;
  /** An action on this row is in flight. */
  busy?: boolean;
}>;

/**
 * A row that is not a link as a whole because it holds controls of its own
 * (`spec/design/pages/trash.html`). Only those controls react to hover —
 * the row has no hover surface. Hairlines between rows are `RowList`'s.
 */
export function Row({
  children,
  actions,
  error,
  level = "item",
  busy = false,
}: RowProps) {
  const hasError = error !== undefined && error !== null && error !== false;
  return (
    <div aria-busy={busy || undefined}>
      <div
        className={
          level === "nested"
            ? `flex items-start gap-lg pt-xs pl-lg font-base text-sm leading-normal text-neutral-700 ${hasError ? "pb-sm" : "pb-md"}`
            : `flex items-start gap-lg pt-row font-base text-base leading-normal text-neutral-900 ${hasError ? "pb-sm" : "pb-row"}`
        }
      >
        <div className="min-w-[0] flex-1">{children}</div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-sm">{actions}</div>
        )}
      </div>
      {hasError ? <div className="pb-row">{error}</div> : null}
    </div>
  );
}
