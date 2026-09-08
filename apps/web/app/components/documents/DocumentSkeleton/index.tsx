/** Shaped to the document screens' DOM: a context line, a title and three text bars. */
export function DocumentSkeleton() {
  return (
    <div
      className="fog-document"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="fog-sr-only">読み込み中</span>
      <div className="fog-skeleton-date" aria-hidden="true" />
      <div className="fog-skeleton-entry" aria-hidden="true">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}
