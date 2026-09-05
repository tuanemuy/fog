export function TimelineSkeleton() {
  return (
    <div
      className="fog-timeline fog-skeleton"
      role="status"
      aria-label="メモを読み込み中"
    >
      <div className="fog-skeleton-date" />
      {[1, 2, 3].map((key) => (
        <div className="fog-skeleton-entry" key={key}>
          <div />
          <div />
          <div />
        </div>
      ))}
      <span className="fog-sr-only">メモを読み込み中…</span>
    </div>
  );
}
