/**
 * Normalization applied to text before it reaches the search index — and to
 * the query before it is matched against it. Running it on only one side is
 * the failure mode: half-width and full-width forms, and composed versus
 * decomposed sequences, would then index and query differently.
 */
export function normalizeForIndex(value: string): string {
  return value.normalize("NFKC").trim();
}
