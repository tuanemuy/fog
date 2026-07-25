/**
 * Wordmark plus the accent dot.
 *
 * The accent colour is allowed to appear only as this 6px dot
 * (spec/design/index.md「色は役割」). `bg-accent` has exactly two call
 * sites: here and `layout/AppShell`'s mobile header, which repeats the
 * same dot next to the page title without going through this component.
 * Change the accent's treatment in both.
 */
export function Brand() {
  return (
    <span className="flex items-center gap-sm text-lg font-semibold text-neutral-900">
      <span>fog</span>
      <span
        aria-hidden="true"
        className="size-dot flex-none rounded-full bg-accent"
      />
    </span>
  );
}
