/**
 * Counts a string in Unicode code points, not UTF-16 code units.
 *
 * Every "N 文字" bound in the spec is a code-point bound (memo bodies,
 * client names, passwords). `String.prototype.length` counts surrogate
 * pairs twice, which silently relaxes minimums and tightens maximums for
 * text containing emoji or non-BMP scripts — on a password minimum that is
 * a real weakening. Domains that enforce a length invariant use this.
 */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}
