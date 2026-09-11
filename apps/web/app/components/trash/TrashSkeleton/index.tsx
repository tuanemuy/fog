/** Shaped to `TrashBoard`: the header line and three rows. */
export function TrashSkeleton() {
  return (
    <div
      className="fog-trash"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="fog-sr-only">読み込み中</span>
      <div className="fog-skeleton-line" aria-hidden="true" />
      {[0, 1, 2].map((n) => (
        <div className="fog-skeleton-entry" key={n} aria-hidden="true">
          <div />
          <div />
        </div>
      ))}
    </div>
  );
}
