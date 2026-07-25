type SkeletonProps = {
  className?: string;
};

/**
 * Visual placeholder block for loading states.
 *
 * `aria-hidden` because the surrounding skeleton container owns the single
 * status announcement (`role="status"` + sr-only label); individual bars must
 * not each speak to a screen reader. `motion-reduce:animate-none` respects
 * `prefers-reduced-motion`.
 *
 * The fill is `neutral-300`, not `neutral-200`: the latter is the exact
 * value of `--color-bg-page`, so a bar painted with it would be invisible
 * on the page background.
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-sm bg-neutral-300 motion-reduce:animate-none ${className}`}
    />
  );
}
