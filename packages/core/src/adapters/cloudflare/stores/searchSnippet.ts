/**
 * The excerpt a search result shows, cut from the **original** text — the
 * index holds NFKC-normalized copies, and what the reader sees must be
 * what they typed. Grapheme units so a cut never splits a combining
 * sequence or an emoji; the match is located on a per-grapheme
 * normalization so a half-width keyword finds its full-width original.
 *
 * A display budget, not a business rule: the domain only asks that the
 * snippet be a non-empty excerpt and never the whole of a long text.
 */

const WINDOW_GRAPHEMES = 140;
const LEAD_GRAPHEMES = 40;
const ELLIPSIS = "…";

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

function graphemesOf(text: string): string[] {
  if (segmenter === null) return Array.from(text);
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function buildSnippet(original: string, keyword: string): string {
  const flat = original.replace(/\r?\n/g, " ");
  const graphemes = graphemesOf(flat);
  const starts: number[] = [];
  let folded = "";
  for (const grapheme of graphemes) {
    starts.push(folded.length);
    folded += fold(grapheme);
  }
  const needle = fold(keyword.trim());
  const hit = needle.length === 0 ? -1 : folded.indexOf(needle);
  let start = 0;
  if (hit >= 0) {
    let index = starts.length - 1;
    while (index > 0 && (starts[index] as number) > hit) index -= 1;
    start = Math.max(0, index - LEAD_GRAPHEMES);
  }
  start = Math.max(0, Math.min(start, graphemes.length - WINDOW_GRAPHEMES));
  const end = Math.min(graphemes.length, start + WINDOW_GRAPHEMES);
  const text = graphemes.slice(start, end).join("").trim();
  return `${start > 0 ? ELLIPSIS : ""}${text}${end < graphemes.length ? ELLIPSIS : ""}`;
}
