import { diffLines } from "diff";

export type DiffLineKind = "added" | "removed" | "context";

export type DiffLine = Readonly<{ kind: DiffLineKind; text: string }>;

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  // A chunk normally ends with the newline of its last line; that final
  // separator is not a line of its own.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The two full snapshots as one line-level unified sequence, in document
 * order: removed lines of a hunk before its added ones, unchanged lines
 * as context (`spec/design/pages/memo-history.html`). Revisions are whole
 * snapshots and no diff is stored, so this is where the diff is computed
 * (`spec/usecases/memo.md`, diffMemoRevisions).
 */
export function toDiffLines(base: string, target: string): DiffLine[] {
  // Without `ignoreNewlineAtEof` a last line gains a spurious −/+ pair the
  // moment a line is appended after it, because "b" and "b\n" differ.
  return diffLines(base, target, { ignoreNewlineAtEof: true }).flatMap(
    (change) => {
      const kind: DiffLineKind = change.added
        ? "added"
        : change.removed
          ? "removed"
          : "context";
      return splitLines(change.value).map((text) => ({ kind, text }));
    },
  );
}
