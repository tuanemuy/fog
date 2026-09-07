/**
 * The Durable Object's SQLite accepts at most 100 bind parameters per
 * statement (CLAUDE.md「Storage limits」), so a read keyed on a list of ids
 * is issued once per chunk of that size rather than once.
 *
 * **This is not the N+1 the bulk reads exist to avoid.** The number of
 * statements grows with `ids.length / 100` and not with it, so a topic
 * holding ninety documents still costs one query; what would make it N is
 * one statement per id.
 */
export const SQL_MAX_BIND_PARAMETERS = 100;

/**
 * Splits ids into runs a single statement can bind, dropping duplicates.
 *
 * De-duplicating here rather than at each call site is what keeps the
 * chunk count a function of the *distinct* ids: a caller that collected
 * `topicId`s from a list of documents would otherwise pay for the
 * repetitions. An empty input yields no chunks at all, which is how a
 * caller skips the query entirely.
 */
export function bindChunks<T extends string>(
  ids: readonly T[],
  size: number = SQL_MAX_BIND_PARAMETERS,
): T[][] {
  const distinct = [...new Set(ids)];
  const chunks: T[][] = [];
  for (let index = 0; index < distinct.length; index += size) {
    chunks.push(distinct.slice(index, index + size));
  }
  return chunks;
}

/** `?, ?, …` — one placeholder per bound value. */
export function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}
