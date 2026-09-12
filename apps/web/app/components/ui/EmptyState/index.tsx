import type { ReactNode } from "react";

export type EmptyStateProps = Readonly<{
  /** One sentence. No heading, icon or explanation goes with it. */
  message: string;
  /** At most one control: a `Button` / `ButtonLink` (retry, back to a list). */
  action?: ReactNode;
  /**
   * The sentence is the page's `h1`, with the same look: for a route error
   * or 404 standing in for a screen whose frame draws no heading
   * (`usePageHeadingOwner`).
   */
  asPageHeading?: boolean;
}>;

const SENTENCE_CLASS =
  "font-base text-base leading-normal text-neutral-600 next-sibling:mt-lg";

/**
 * An empty list, a missing target, a failed load: one centred sentence and,
 * when there is somewhere to go, one control under it
 * (`spec/design/index.md`: 空状態の一文＋操作1つ).
 */
export function EmptyState({
  message,
  action,
  asPageHeading = false,
}: EmptyStateProps) {
  return (
    <div className="py-2xl text-center">
      {asPageHeading ? (
        <h1 className={SENTENCE_CLASS}>{message}</h1>
      ) : (
        <p className={SENTENCE_CLASS}>{message}</p>
      )}
      {action === undefined ? null : <div>{action}</div>}
    </div>
  );
}
