import { describe, expect, it } from "vitest";
import { EOF_NEWLINE_NOTE, toDiffLines } from "@/presentation/diff";

describe("toDiffLines", () => {
  it("marks unchanged lines as context", () => {
    expect(toDiffLines("a\nb\n", "a\nb\n")).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
    ]);
  });

  it("emits the removed line before the added one of the same hunk", () => {
    expect(toDiffLines("keep\nold\nend", "keep\nnew\nend")).toEqual([
      { kind: "context", text: "keep" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "context", text: "end" },
    ]);
  });

  it("treats an empty base as all additions and an empty target as all removals", () => {
    expect(toDiffLines("", "one\ntwo")).toEqual([
      { kind: "added", text: "one" },
      { kind: "added", text: "two" },
    ]);
    expect(toDiffLines("one\ntwo\n", "")).toEqual([
      { kind: "removed", text: "one" },
      { kind: "removed", text: "two" },
    ]);
  });

  it("does not turn a trailing newline into an empty line", () => {
    expect(toDiffLines("a\n", "a\nb\n")).toEqual([
      { kind: "context", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });

  it("says so when only the final newline differs, instead of showing nothing", () => {
    expect(toDiffLines("a", "a\n")).toEqual([
      { kind: "context", text: "a" },
      { kind: "note", text: EOF_NEWLINE_NOTE },
    ]);
    expect(toDiffLines("a\nb\n", "a\nb")).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "note", text: EOF_NEWLINE_NOTE },
    ]);
    expect(toDiffLines("a\n", "a\n")).toEqual([{ kind: "context", text: "a" }]);
  });

  it("keeps a blank line inside the body as a line", () => {
    expect(toDiffLines("a\n\nb", "a\n\nb\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "" },
      { kind: "context", text: "b" },
      { kind: "added", text: "c" },
    ]);
  });
});
