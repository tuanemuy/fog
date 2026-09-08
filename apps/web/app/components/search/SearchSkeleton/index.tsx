/** Shaped to `SearchPanel`'s result list: the count line and three rows. */
export function SearchSkeleton() {
  return (
    <div
      className="fog-search-results"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="fog-sr-only">検索中</span>
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
