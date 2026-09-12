import type { ReactNode } from "react";

export type RowListProps = Readonly<{
  /** `<ol>` when the order means something (search hits, revisions). */
  ordered?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** `<li>` elements, each holding a `RowLink` or a `Row`. */
  children: ReactNode;
}>;

// The hairline sits on the `<li>`, which spans the text column; a `RowLink`
// inside it bleeds its hover surface past the column, and the line does not
// follow (`spec/design/pages/document.html`: 区切り線は張り出しに追従させない).
const LIST_CLASS = "*:border-neutral-100 *:not-first:border-t";

/**
 * A list of rows separated by hairlines between the items — none above the
 * first, none below the last. The separator is the list's, so a screen writes
 * bare `<li>`s and never draws a line of its own.
 */
export function RowList({ ordered = false, children, ...aria }: RowListProps) {
  return ordered ? (
    <ol {...aria} className={LIST_CLASS}>
      {children}
    </ol>
  ) : (
    <ul {...aria} className={LIST_CLASS}>
      {children}
    </ul>
  );
}
