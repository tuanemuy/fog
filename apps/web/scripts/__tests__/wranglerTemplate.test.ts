import { describe, expect, it } from "vitest";
import { renderWranglerTemplate } from "../lib/wranglerTemplate";

const placeholder = (name: string) => `$\{${name}}`;

describe("renderWranglerTemplate", () => {
  it("substitutes every occurrence of every placeholder", () => {
    const prefix = placeholder("PREFIX");
    expect(
      renderWranglerTemplate(
        `name = "${prefix}"\nscript_name = "${prefix}-state"\nurl = "${placeholder("APP_URL")}"`,
        { PREFIX: "fog-staging", APP_URL: "https://fog.example" },
        "t.tpl",
      ),
    ).toBe(
      'name = "fog-staging"\nscript_name = "fog-staging-state"\nurl = "https://fog.example"',
    );
  });

  it("aborts on a placeholder with no value, naming it and the template", () => {
    expect(() =>
      renderWranglerTemplate(
        `a = "${placeholder("KNOWN")}"\nb = "${placeholder("MISSING")}"`,
        { KNOWN: "x", MISSING: undefined },
        "wrangler.staging.toml.tpl",
      ),
    ).toThrow(/\$\{MISSING\} in wrangler\.staging\.toml\.tpl/);
  });

  it("substitutes an empty string rather than treating it as missing", () => {
    expect(
      renderWranglerTemplate(
        `a = "${placeholder("EMPTY")}"`,
        { EMPTY: "" },
        "t",
      ),
    ).toBe('a = ""');
  });

  it("leaves text that is not a placeholder untouched", () => {
    const text = `cost = $5 {x} ${placeholder("lower")}`;
    expect(renderWranglerTemplate(text, {}, "t")).toBe(text);
  });
});
