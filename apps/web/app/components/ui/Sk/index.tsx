export type SkProps = Readonly<{
  /** Stand-in text of about the length the real text will have. */
  children: string;
}>;

/**
 * Skeleton text laid over the real DOM: the loading
 * screen is built from the same primitives and elements as the loaded one,
 * and only the text is wrapped in `Sk`, which hides the glyphs behind a flat
 * block. The line keeps its real height, so the swap to loaded content does
 * not move anything. It does not animate.
 *
 * Hidden from assistive technology — the stand-in text is not content. The
 * region around the skeleton carries the one `aria-busy` and loading label.
 */
export function Sk({ children }: SkProps) {
  return (
    <span
      aria-hidden="true"
      className="box-decoration-clone select-none rounded-sm bg-neutral-100 text-transparent"
    >
      {children}
    </span>
  );
}
