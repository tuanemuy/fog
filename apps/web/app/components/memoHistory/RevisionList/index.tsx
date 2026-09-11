"use client";

import { type ReactNode, useId } from "react";
import { RowList } from "@/components/ui/RowList";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { SHEET_SECTION_CLASS } from "@/components/ui/SheetSection";
import { formatDateTime } from "@/presentation/time";

/** One version as its row shows it: when, then who (and why, for a document). */
export type RevisionRow = Readonly<{
  revisionNumber: number;
  createdAt: Date;
  meta: string;
}>;

/** The first pick is the base, the second the target. */
export type RevisionSelection = Readonly<{
  base: number | null;
  target: number | null;
}>;

export const NO_SELECTION: RevisionSelection = { base: null, target: null };

/**
 * The name of what the history is of, when the sheet shows it above the
 * history (`.doc-title` in `spec/design/pages/document-history.html`).
 */
export const HISTORY_SUBJECT_CLASS =
  "font-base text-xl font-bold leading-tight text-neutral-900 wrap-anywhere";

/**
 * The history under something else on the sheet: it opens with the hairline
 * and the gap that separate it from what is above (`.history-section`).
 */
export const HISTORY_SECTION_CLASS = SHEET_SECTION_CLASS;

// A version row is neither of `RowLink` / `Row`: the whole row is one toggle
// button (`.revision-row` in `spec/design/pages/memo-history.html`). Its hover
// and focus surface bleeds `--space-md` past the text column like `RowLink`'s,
// and the `<li>` is a column flexbox so the bled row stretches across it.
// The hairline between rows is `RowList`'s, on the `<li>`, so it does not
// follow the bleed.
const ROW_CLASS = "-mx-md flex items-center gap-md rounded-md px-md py-row";
const TOGGLE_CLASS = `${ROW_CLASS} cursor-pointer text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus`;
const TIME_CLASS =
  "block font-base text-base font-medium leading-tight text-neutral-900 tabular-nums";
const META_CLASS =
  "mt-xs block font-base text-xs leading-tight text-neutral-400";
const BADGE_CLASS =
  "inline-flex shrink-0 items-center rounded-full bg-bg-card px-sm py-xs font-base text-xs font-medium leading-tight text-primary-darker";

/** The text of a version row. The skeleton lays `Sk` over the same two lines. */
export function RevisionRowText({
  time,
  meta,
}: Readonly<{ time: ReactNode; meta: ReactNode }>) {
  return (
    <span className="block min-w-[0] flex-1">
      <span className={TIME_CLASS}>{time}</span>
      <span className={META_CLASS}>{meta}</span>
    </span>
  );
}

/** A version row that cannot be picked: the only version, or a skeleton's. */
export function StaticRevisionRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex flex-col">
      <div className={ROW_CLASS}>{children}</div>
    </li>
  );
}

export type RevisionListProps = Readonly<{
  /** Ascending by `revisionNumber`. */
  revisions: readonly RevisionRow[];
  selection: RevisionSelection;
  /** `null` when there is nothing to compare: the rows are then not buttons. */
  onSelect: ((revisionNumber: number) => void) | null;
}>;

/**
 * 「履歴」 and its versions, oldest first — the one shape the memo and the
 * document history share. With `onSelect` each row is a toggle button whose
 * pressed state and 「比較元」 / 「比較先」 badge follow `selection`; with
 * `null` the rows are plain and nothing reacts.
 */
export function RevisionList({
  revisions,
  selection,
  onSelect,
}: RevisionListProps) {
  const labelId = useId();
  return (
    <>
      <SectionLabel id={labelId}>履歴</SectionLabel>
      <RowList ordered aria-labelledby={labelId}>
        {revisions.map((revision) => {
          const n = revision.revisionNumber;
          const text = (
            <RevisionRowText
              time={formatDateTime(revision.createdAt)}
              meta={revision.meta}
            />
          );
          if (onSelect === null) {
            return <StaticRevisionRow key={n}>{text}</StaticRevisionRow>;
          }
          const badge =
            n === selection.base
              ? "比較元"
              : n === selection.target
                ? "比較先"
                : null;
          return (
            <li key={n} className="flex flex-col">
              <button
                type="button"
                aria-pressed={badge !== null}
                onClick={() => onSelect(n)}
                className={`${TOGGLE_CLASS} ${badge === null ? "hover:bg-neutral-50" : "bg-primary-lighter"}`}
              >
                {text}
                {badge === null ? null : (
                  <span className={BADGE_CLASS}>{badge}</span>
                )}
              </button>
            </li>
          );
        })}
      </RowList>
    </>
  );
}
