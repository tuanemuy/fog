/**
 * Shaped to `TimelineBoard`'s DOM — a day heading and three entries — so the
 * streamed list swaps in without layout shift. One polite announcement for the
 * region; the bars are decorative.
 */
export function TimelineSkeleton() {
  return (
    <section
      className="fog-timeline"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="fog-sr-only">読み込み中</span>
      <div className="fog-skeleton-date" aria-hidden="true" />
      {[0, 1, 2].map((n) => (
        <div className="fog-skeleton-entry" key={n} aria-hidden="true">
          <div />
          <div />
          <div />
        </div>
      ))}
    </section>
  );
}
