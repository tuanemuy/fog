export type SectionLabelProps = Readonly<{
  children: string;
  /** Heading level in the page outline; the look is the same at both. */
  level?: 2 | 3;
  /** For a list that names itself by this label (`aria-labelledby`). */
  id?: string;
}>;

// The label carries the gap to what follows it (tokens.md「余白の向き」の
// `.ラベル + *`), so reused alone it brings no margin along.
const LABEL_CLASS =
  "font-base text-xs font-semibold uppercase leading-tight tracking-label text-neutral-600 next-sibling:mt-md";

/**
 * The small caps-style label that opens a section inside the sheet (出典,
 * ドキュメント, 履歴). The line that separates sections belongs to the
 * section, not to this label.
 */
export function SectionLabel({ children, level = 2, id }: SectionLabelProps) {
  return level === 3 ? (
    <h3 id={id} className={LABEL_CLASS}>
      {children}
    </h3>
  ) : (
    <h2 id={id} className={LABEL_CLASS}>
      {children}
    </h2>
  );
}
