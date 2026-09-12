import { SHEET_TITLE_CLASS } from "@/components/ui/SheetTitle";

// The text of the topic screens, shared by the loaded DOM and its skeleton:
// the skeleton lays `Sk` over the same elements, so both read their line
// heights from one definition.

/** A topic row's name line (`spec/design/pages/topics.html`, `.t-name`). */
export const TOPIC_NAME_CLASS = "flex items-center gap-sm font-medium";

/** An archived row's name: neutral and regular (`.archived .t-name`). */
export const ARCHIVED_TOPIC_NAME_CLASS =
  "flex items-center gap-sm font-regular text-neutral-600";

/** A topic row's description (`.t-desc`). */
export const TOPIC_DESC_CLASS =
  "mt-xs block text-sm leading-normal text-neutral-600";

/** The title line of P-07: the name and its menu (`.topic-head`). */
export const TOPIC_HEAD_CLASS = "flex items-center justify-between gap-sm";

/** P-07's name (`.topic-title`): the sheet's title, shrinkable in the head row. */
export const TOPIC_TITLE_CLASS = `min-w-[0] ${SHEET_TITLE_CLASS}`;

/** P-07's description (`.topic-desc`). */
export const TOPIC_DETAIL_DESC_CLASS =
  "mt-sm font-base text-sm leading-normal text-neutral-600 wrap-anywhere";

/** The status line under the head: 完了済み and the one action (`.topic-status`). */
export const TOPIC_STATUS_CLASS = "mt-md flex flex-wrap items-center gap-sm";

/** A document row's title and its update day (`.doc-row .d-name` / `.d-meta`). */
export const DOCUMENT_NAME_CLASS = "block font-medium leading-tight";
export const DOCUMENT_META_CLASS =
  "mt-xs block text-xs leading-tight text-neutral-400";
