import type { ReactNode } from "react";

export type EmptyStateProps = Readonly<{
  /** One sentence. No heading, icon or explanation goes with it. */
  message: string;
  /** At most one control: a `Button` / `ButtonLink` (retry, back to a list). */
  action?: ReactNode;
}>;

/**
 * An empty list, a missing target, a failed load: one centred sentence and,
 * when there is somewhere to go, one control under it
 * (`spec/design/index.md`: 空状態の一文＋操作1つ).
 */
export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div className="py-2xl text-center">
      <p className="font-base text-base leading-normal text-neutral-600 next-sibling:mt-lg">
        {message}
      </p>
      {action === undefined ? null : <div>{action}</div>}
    </div>
  );
}
