import type { ReactNode } from "react";

export type LoadingRegionProps = Readonly<{
  /**
   * The label is the page's `h1`, hidden as it always is: for a skeleton
   * that stands in for a screen whose own title is the page's heading
   * (`PageHeaderDeclaration`'s `h1: "sheet"`), so the page keeps a heading
   * while that title is still loading.
   */
  asPageHeading?: boolean;
  children: ReactNode;
}>;

/**
 * The region a skeleton fills: one polite loading
 * label for the whole of it, and `aria-busy` while it stands in. The
 * stand-in text inside is hidden from assistive technology (`Sk`), so this
 * label is the only thing it says.
 */
export function LoadingRegion({
  asPageHeading = false,
  children,
}: LoadingRegionProps) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      {asPageHeading ? (
        <h1 className="sr-only">読み込み中</h1>
      ) : (
        <span className="sr-only">読み込み中</span>
      )}
      {children}
    </div>
  );
}
