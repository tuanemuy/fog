type SkeletonProps = {
  className?: string;
};

/**
 * Visual placeholder block for loading states.
 *
 * `aria-hidden` because the surrounding skeleton container owns the single
 * status announcement (`role="status"` + sr-only label); individual bars must
 * not each speak to a screen reader. It does not animate: motion beyond the
 * two token transitions is out of scope (spec/design/index.md).
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`block rounded-sm bg-neutral-200 ${className}`}
    />
  );
}
