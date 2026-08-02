import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = new URL("../valueObject.ts", import.meta.url);

/**
 * The SSO canonical's separator is `U+0000`, and it must appear in the source
 * as a JavaScript escape rather than as the byte itself.
 *
 * A raw NUL makes `grep` classify the file as binary, at which point it reports
 * **zero matches without saying so** — breaking the mechanical checks and the
 * hand-off searches in the same stroke, and doing it silently.
 */
describe("valueObject.ts", () => {
  const source = readFileSync(SOURCE, "utf8");

  it("writes the SSO separator as an escape", () => {
    expect(source).toContain("u0000");
  });

  it("contains no raw NUL byte", () => {
    expect(source.includes(String.fromCharCode(0))).toBe(false);
  });
});
