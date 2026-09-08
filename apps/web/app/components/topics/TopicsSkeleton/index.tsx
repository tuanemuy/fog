/** Shaped to `TopicList`'s DOM: the create row and three topic rows. */
export function TopicsSkeleton() {
  return (
    <div
      className="fog-topics"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="fog-sr-only">読み込み中</span>
      <div className="fog-skeleton-create" aria-hidden="true" />
      {[0, 1, 2].map((n) => (
        <div className="fog-skeleton-entry" key={n} aria-hidden="true">
          <div />
          <div />
        </div>
      ))}
    </div>
  );
}
