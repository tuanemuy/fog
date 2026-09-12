/**
 * Where a `…` menu's trigger will be, on a skeleton: its box (the row
 * placement's padding around the small glyph), empty, and nothing to press.
 * The loaded row swaps its trigger in without a shift.
 */
export function MenuPlaceholder() {
  return (
    <span aria-hidden="true" className="flex p-xs">
      <span className="size-icon-sm" />
    </span>
  );
}
