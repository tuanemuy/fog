import type { ReactNode } from "react";
import { SectionLabel } from "@/components/ui/SectionLabel";

/**
 * The frame of a block inside the sheet: the section gap above it and one
 * hairline across it (`spec/design/pages/document.html`, `.origin`;
 * `topic-detail.html`, `.section-label`). Exported for the blocks that build
 * their own element — a settings group, the auth sheet's blocks, a block
 * opened by a control rather than a label — so that the one definition
 * reaches all of them; a block that is a labelled region uses `SheetSection`.
 */
export const SHEET_SECTION_CLASS =
  "mt-section border-t border-neutral-100 pt-lg";

export type SheetSectionProps = Readonly<{
  /** The section's label, which also names it as a region. */
  label: string;
  /** Heading level of the label under the page's `h1`. */
  level?: 2 | 3;
  children: ReactNode;
}>;

/**
 * A labelled block of the sheet: P-07's ドキュメント and 関連メモ, P-08's
 * 出典. The line belongs to the section, not to the label, so a
 * `SectionLabel` used on its own brings no line with it.
 */
export function SheetSection({
  label,
  level = 3,
  children,
}: SheetSectionProps) {
  return (
    <section aria-label={label} className={SHEET_SECTION_CLASS}>
      <SectionLabel level={level}>{label}</SectionLabel>
      {children}
    </section>
  );
}
