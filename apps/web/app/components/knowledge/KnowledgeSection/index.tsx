import type { ReactNode } from "react";
import { SectionLabel } from "@/components/ui/SectionLabel";

export type KnowledgeSectionProps = Readonly<{
  /** The section's label, which also names it as a region. */
  label: string;
  /** Heading level of the label under the page's `h1`. */
  level?: 2 | 3;
  children: ReactNode;
}>;

/**
 * A block of the sheet that follows the one above it with the section gap
 * and one hairline, opened by its label (`spec/design/pages/document.html`,
 * `.origin`; `topic-detail.html`, `.section-label`): P-07's ドキュメント and
 * 関連メモ, P-08's 元になったメモ. The line belongs to the section, not to
 * the label (`SectionLabel`).
 */
export function KnowledgeSection({
  label,
  level = 3,
  children,
}: KnowledgeSectionProps) {
  return (
    <section
      aria-label={label}
      className="mt-section border-t border-neutral-100 pt-lg"
    >
      <SectionLabel level={level}>{label}</SectionLabel>
      {children}
    </section>
  );
}
