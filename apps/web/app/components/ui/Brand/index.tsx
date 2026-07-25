/**
 * Wordmark plus the accent dot.
 *
 * The accent colour appears only as this 6px dot (spec/design/index.md
 * 「色は役割」). `AppShell`'s mobile header repeats the dot without going
 * through this component — change the accent's treatment in both.
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
