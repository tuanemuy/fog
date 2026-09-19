import { type DiffLine, toDiffLines } from "@/presentation/diff";

const MARK: Record<DiffLine["kind"], string> = {
  added: "+",
  removed: "−",
  context: "",
  note: "",
};

const SPOKEN: Record<DiffLine["kind"], string> = {
  added: "追加: ",
  removed: "削除: ",
  context: "",
  note: "",
};

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  added: "bg-success-bg",
  removed: "bg-error-bg",
  context: "",
  note: "",
};

const MARK_CLASS: Record<DiffLine["kind"], string> = {
  added: "text-success-dark",
  removed: "text-error-dark",
  context: "text-neutral-500",
  note: "text-neutral-500",
};

const TEXT_CLASS = "min-w-[0] flex-1 whitespace-pre-wrap wrap-break-word";

function LineText({ line }: Readonly<{ line: DiffLine }>) {
  switch (line.kind) {
    case "added":
      return (
        <ins className={`${TEXT_CLASS} text-success-dark no-underline`}>
          {line.text}
        </ins>
      );
    case "removed":
      return (
        <del className={`${TEXT_CLASS} text-error-dark no-underline`}>
          {line.text}
        </del>
      );
    case "context":
      return (
        <span className={`${TEXT_CLASS} text-neutral-900`}>{line.text}</span>
      );
    case "note":
      return (
        <span className={`${TEXT_CLASS} text-neutral-600`}>{line.text}</span>
      );
  }
}

/**
 * The line-level unified rendering of `spec/design/pages/memo-history.html`
 * (`.diff-view`): a bordered box that scrolls sideways on its own, one line
 * per row, removed and added lines tinted and marked. The changed text is an
 * `<del>` / `<ins>`, and the sign is spoken as a word, since the mark is
 * hidden and the tint is not read.
 */
export function DiffView({ base, target }: { base: string; target: string }) {
  const lines = toDiffLines(base, target);
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-100 bg-bg-card">
      <div className="p-lg font-base text-sm leading-normal">
        {lines.map((line, index) => (
          <div
            // Lines carry no identity of their own; their position is it.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            className={`flex gap-sm py-xs ${LINE_CLASS[line.kind]}`}
          >
            <span
              aria-hidden="true"
              className={`w-icon-sm shrink-0 text-center ${MARK_CLASS[line.kind]}`}
            >
              {MARK[line.kind]}
            </span>
            {SPOKEN[line.kind] && (
              <span className="sr-only">{SPOKEN[line.kind]}</span>
            )}
            <LineText line={line} />
          </div>
        ))}
      </div>
    </div>
  );
}
