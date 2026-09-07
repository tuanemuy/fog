import { describe, expect, it } from "vitest";
import { snippetOf } from "../text";

const EMOJI = "🙂";

describe("snippetOf", () => {
  it("leaves a short body whole", () => {
    expect(snippetOf("短い本文")).toBe("短い本文");
  });

  it("leaves an empty body whole", () => {
    expect(snippetOf("")).toBe("");
  });

  it("leaves 140 code points untouched, with no ellipsis", () => {
    const body = "あ".repeat(140);
    expect(snippetOf(body)).toBe(body);
  });

  it("cuts at 140 code points and marks the cut on the 141st", () => {
    const snippet = snippetOf("あ".repeat(141));
    expect(snippet).toBe(`${"あ".repeat(140)}…`);
  });

  // The bound is code points, not UTF-16 code units: `body.slice(0, 140)`
  // keeps only 70 of these and would still read as "cut at 140".
  it("counts a non-BMP body in code points", () => {
    expect(snippetOf(EMOJI.repeat(140))).toBe(EMOJI.repeat(140));
    expect(snippetOf(EMOJI.repeat(141))).toBe(`${EMOJI.repeat(140)}…`);
  });

  // 139 BMP characters put the 140th UTF-16 boundary in the middle of the
  // first emoji, so a `slice` on code units ends the snippet on a lone high
  // surrogate — a replacement character on the screen.
  it("never cuts a surrogate pair in half", () => {
    const snippet = snippetOf(`${"あ".repeat(139)}${EMOJI.repeat(10)}`);
    expect(snippet).toBe(`${"あ".repeat(139)}${EMOJI}…`);
    expect([...snippet].length).toBe(141);
  });
});
