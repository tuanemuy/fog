import { describe, expect, it } from "vitest";
import { codePointLength } from "../text";

const EMOJI = "🙂";

describe("codePointLength", () => {
  it("counts an empty string as zero", () => {
    expect(codePointLength("")).toBe(0);
  });

  it("counts BMP characters one by one", () => {
    expect(codePointLength("短い本文")).toBe(4);
  });

  // `String.prototype.length` counts a surrogate pair twice, which tightens
  // every maximum and relaxes every minimum for non-BMP text — on a password
  // minimum that is a real weakening.
  it("counts a surrogate pair as one code point", () => {
    expect(codePointLength(EMOJI)).toBe(1);
    expect(codePointLength(`${"あ".repeat(139)}${EMOJI}`)).toBe(140);
  });
});
