/**
 * Wordmark plus the accent dot — the one place the accent colour is
 * allowed to appear (spec/design/index.md「色は役割」).
 */
export function Brand() {
  return (
    <span className="flex items-center gap-sm text-lg font-semibold text-neutral-900">
      <span>fog</span>
      <span
        aria-hidden="true"
        className="size-(--size-dot) flex-none rounded-full bg-accent"
      />
    </span>
  );
}
