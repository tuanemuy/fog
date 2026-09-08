import { type DiffLine, toDiffLines } from "@/presentation/diff";

const MARK: Record<DiffLine["kind"], string> = {
  added: "+",
  removed: "−",
  context: "",
};

const SPOKEN: Record<DiffLine["kind"], string> = {
  added: "追加: ",
  removed: "削除: ",
  context: "",
};

/** The line-level unified rendering of `spec/design/pages/memo-history.html`. */
export function DiffView({ base, target }: { base: string; target: string }) {
  const lines = toDiffLines(base, target);
  return (
    <div className="fog-diff-view">
      <div className="fog-diff-content">
        {lines.map((line, index) => (
          <div
            // Lines carry no identity of their own; their position is it.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            className={`fog-diff-line ${line.kind}`}
          >
            <span className="fog-diff-mark" aria-hidden="true">
              {MARK[line.kind]}
            </span>
            {SPOKEN[line.kind] && (
              <span className="fog-sr-only">{SPOKEN[line.kind]}</span>
            )}
            <span className="fog-diff-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
