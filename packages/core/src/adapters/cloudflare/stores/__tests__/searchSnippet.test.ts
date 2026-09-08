import { describe, expect, it } from "vitest";
import { buildSnippet } from "../searchSnippet";

describe("buildSnippet", () => {
  it("returns a short text whole, with line breaks folded", () => {
    expect(buildSnippet("first line\nsecond line", "second")).toBe(
      "first line second line",
    );
  });

  it("opens a window around the match with an ellipsis on the cut sides", () => {
    const body = `${"a".repeat(200)}目印${"b".repeat(200)}`;
    const snippet = buildSnippet(body, "目印");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("目印");
    // 140 graphemes plus the two ellipses.
    expect([...snippet].length).toBe(142);
    expect(snippet.indexOf("目印")).toBe(41);
  });

  it("keeps the head when the match is early and the tail when it is late", () => {
    const early = `目印${"x".repeat(300)}`;
    expect(buildSnippet(early, "目印").startsWith("目印")).toBe(true);
    expect(buildSnippet(early, "目印").endsWith("…")).toBe(true);
    const late = `${"x".repeat(300)}目印`;
    expect(buildSnippet(late, "目印").endsWith("目印")).toBe(true);
    expect(buildSnippet(late, "目印").startsWith("…")).toBe(true);
  });

  it("falls back to the head when the keyword is not in the text", () => {
    const body = "z".repeat(300);
    const snippet = buildSnippet(body, "absent");
    expect(snippet).toBe(`${"z".repeat(140)}…`);
  });

  it("finds a half-width keyword in its full-width original and returns the original", () => {
    const body = `全角表記の ｆｏｇ１２３ を含むメモ${"。".repeat(200)}`;
    const snippet = buildSnippet(body, "fog123");
    expect(snippet).toContain("ｆｏｇ１２３");
    expect(snippet).not.toContain("fog123");
    expect(buildSnippet("Case Fold", "case")).toBe("Case Fold");
  });

  it("matches a composed keyword against a decomposed original", () => {
    const decomposed = "が";
    expect(buildSnippet(`${"x".repeat(200)}${decomposed}`, "が")).toContain(
      decomposed,
    );
  });

  it("never splits an emoji or a combining sequence at the cut", () => {
    const body = "👨‍👩‍👧".repeat(200);
    const snippet = buildSnippet(body, "nothing");
    expect(snippet.endsWith("…")).toBe(true);
    const graphemes = [
      ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(snippet),
    ];
    expect(graphemes.length).toBe(141);
    expect(graphemes.slice(0, 140).every((g) => g.segment === "👨‍👩‍👧")).toBe(
      true,
    );
  });
});
