/**
 * Canonical JSON form used as the value of `jobs.payload_digest` and
 * `operations.payload_digest`.
 *
 * **No hash is applied — the column stores the canonical string itself.**
 * `crypto.subtle.digest` is asynchronous and both writers run inside a
 * fully synchronous `transactionSync`, so the derivation has to close
 * synchronously; `spec/database/index.md` asks only that a differing
 * payload for the same key be detected, and says nothing about
 * cryptographic strength. The price is one extra copy of the payload,
 * counted against the DO's 10 GB cap, and — for `jobs`, which binds
 * `payload` and `payload_digest` in one INSERT — a statement of twice the
 * size, so the ceiling that breaks first there is 100 KB per statement
 * rather than 2 MB per row. (`.thread/51/adr.md` ADR-013.)
 *
 * Normalisation: object keys sorted ascending by Unicode code point,
 * recursively; array order preserved; keys whose value is `undefined`
 * dropped (`JSON.stringify` drops them anyway, and doing it explicitly
 * keeps the rule readable).
 *
 * The scope of the comparison is the caller's, and the two differ: `jobs`
 * compares only within the runnable set (`status IN ('pending','running')`),
 * while `operations.payload_digest` carries no state qualifier and holds
 * for the whole life of the row.
 */
export function canonicalPayloadDigest(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// `Array.prototype.sort`'s default comparator orders by UTF-16 code
// unit, which disagrees with code-point order for surrogate pairs.
// Iterating the string yields code points, so comparing those arrays
// implements the documented rule exactly.
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const l = left[i]?.codePointAt(0) ?? 0;
    const r = right[i]?.codePointAt(0) ?? 0;
    if (l !== r) return l - r;
  }
  return left.length - right.length;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(byCodePoint)) {
    const entry = source[key];
    if (entry === undefined) continue;
    sorted[key] = canonicalize(entry);
  }
  return sorted;
}
