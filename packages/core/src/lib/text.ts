const SNIPPET_MAX_LENGTH = 140;

const ELLIPSIS = "…";

/**
 * How much of a memo's body travels as a preview of it: 140 code points,
 * with an ellipsis where the cut was made.
 *
 * Cut on the object's side rather than by the screen: a topic whose
 * documents cite a hundred memos would otherwise put a hundred full bodies
 * — up to 10,000 code points each — on the wire so that the list could show
 * two lines of each.
 *
 * A display and transfer budget rather than a business invariant, so it lives
 * outside the layered tree: the adapter that composes a row and the component
 * that renders one are the only callers, and neither may own the rule alone.
 * The same memo is previewed on both sides of a save — the editor shows
 * candidates it has not yet cited, and the reading screens show the sources of
 * a document that was — so two copies of the rule would let those two views of
 * one memo disagree, and neither a type nor a test would see it.
 *
 * The bound counts Unicode code points, not UTF-16 code units: cutting on code
 * units both halves the budget for non-BMP text and can end the snippet on a
 * lone surrogate.
 */
export function snippetOf(body: string): string {
  const characters = [...body];
  if (characters.length <= SNIPPET_MAX_LENGTH) return body;
  return `${characters.slice(0, SNIPPET_MAX_LENGTH).join("")}${ELLIPSIS}`;
}
