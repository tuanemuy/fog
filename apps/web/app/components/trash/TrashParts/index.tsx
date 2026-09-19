import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";

/**
 * The retention sentence of P-12. The retention period is a setting
 * (P-13) that the trash list does not carry, so the sentence names the
 * deadline rather than a number of days.
 */
export const TRASH_NOTE =
  "ここにある項目は保持期限を過ぎると完全に削除されます。";

/**
 * The head of the trash (`spec/design/pages/trash.html`, `.trash-header`):
 * the retention sentence and the one list-wide control, 「空にする」, above
 * a hairline.
 */
export function TrashHeader({ action }: Readonly<{ action: ReactNode }>) {
  return (
    <div className="flex items-start justify-between gap-md border-neutral-100 border-b pb-lg next-sibling:mt-sm">
      <p className="min-w-[0] flex-1 font-base text-sm leading-normal text-neutral-600">
        {TRASH_NOTE}
      </p>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/** The line under a top-level row's title: the kind and the days left. */
export function TrashTags({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="mt-sm flex flex-wrap items-center gap-sm">{children}</p>;
}

/** The kind of a top-level row (`.pill`): メモ / ドキュメント / トピック. */
export function KindPill({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="rounded-full bg-bg-card px-sm py-xs font-base text-xs font-medium leading-tight text-neutral-600 [border:var(--border-input)]">
      {children}
    </span>
  );
}

/** 「残りN日」 (`.remaining-days`). */
export function RemainingDays({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="whitespace-nowrap font-base text-xs tabular-nums text-neutral-400">
      {children}
    </span>
  );
}

/** The action in flight on this row, in place of the days left (`.row-status`). */
export function RowStatus({ label }: Readonly<{ label: string }>) {
  return (
    <span className="inline-flex items-center gap-sm font-base text-xs text-neutral-400">
      <Icon name="spinner" size="xs" />
      {label}
    </span>
  );
}

export type TrashRowActionsProps = Readonly<{
  /** Names the row in both accessible names, so two rows' buttons differ. */
  title: string;
  disabled: boolean;
  onRestore?: () => void;
  onDelete?: () => void;
}>;

/** The row's two icon buttons: restore, then hard delete. */
export function TrashRowActions({
  title,
  disabled,
  onRestore,
  onDelete,
}: TrashRowActionsProps) {
  return (
    <>
      <IconButton
        icon="restore"
        label={`${title} を復元`}
        size="md"
        placement="row"
        tone="primary"
        disabled={disabled}
        onClick={onRestore}
      />
      <IconButton
        icon="delete"
        label={`${title} を完全に削除`}
        size="md"
        placement="row"
        tone="danger"
        disabled={disabled}
        onClick={onDelete}
      />
    </>
  );
}
