type SkeletonProps = {
  className?: string;
};

/**
 * Visual placeholder block for loading states.
 *
 * `aria-hidden` because the surrounding container owns the single
 * `role="status"` announcement — individual bars must not each speak.
 * The fill is `neutral-300`: `neutral-200` equals `--color-bg-page`, so a
 * bar painted with it would be invisible.
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-sm bg-neutral-300 motion-reduce:animate-none ${className}`}
    />
  );
}
