import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { describe, expect, it } from "vitest";

// Holds "values come only from the tokens" (spec/design/tokens.md) over both
// ways a value reaches the page: the hand-written CSS under `styles/`, and the
// utility CSS Tailwind generates from `apps/web`'s sources — the latter is
// where an arbitrary value (`p-[13px]`) or a bare number (`border-3`) lands,
// so it is checked as CSS rather than as className text. On top of that it
// closes the three paths by which a primitive's look could be redefined from
// outside it: a wrapper's other-element variants (`*:` / `**:` /
// descendant-targeting) outside `components/ui`, a class selector in the
// hand-written CSS, and a `@custom-variant` / `@utility` in `styles/` that
// gives such a selector a name (`next-sibling:mt-*` is the one exception).
// The third of those reads the `styles/` files themselves, so it also holds
// that `index.css` imports nothing but `tailwindcss` and its two siblings,
// and that no file there loads JS through a `@plugin` or a `@config` — any of
// the three would define names the scan never sees.
//
// It lives in `lint/` for the same reason `banList.test.ts` does: it reads
// across `spec/` and `apps/web`.
//
// Out of reach, stated in tokens.md and docs/test.md: the mock HTML, TSX
// `style` attributes, and a className Tailwind cannot see statically (which
// also never becomes CSS). Tailwind's own output that no source asked for —
// preflight, `@property` registrations and the `@layer properties` fallback —
// is not checked: only the `@layer utilities` block is.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const APP_ROOT = join(WEB_ROOT, "app");
const STYLES = join(APP_ROOT, "styles");
const UI_ROOT = join(APP_ROOT, "components", "ui");
const LINT_DIR = join(REPO_ROOT, "lint");
const TOKENS_MD = join(REPO_ROOT, "spec", "design", "tokens.md");
const ADR_DIR = join(REPO_ROOT, "spec", "adr");

const TOKENS_CSS = "tokens.css";
const THEME_CSS = "theme.css";
const ENTRY_CSS = "index.css";

// The one sibling-targeting variant (`index.css`'s `@custom-variant`): the
// label side of tokens.md's `.label + * { margin-top }`.
const NEXT_SIBLING_VARIANT = "next-sibling";

// ---------------------------------------------------------------------------
// A small CSS walker: enough for the Tailwind output and hand-written files.
// Comments are dropped, strings and parentheses are respected, and nesting is
// kept as the stack of enclosing preludes (`@layer utilities`, `.p-md`, …).

type CssDecl = {
  readonly prop: string;
  readonly value: string;
  readonly context: readonly string[];
  readonly line: number;
};
type CssBlock = {
  readonly prelude: string;
  readonly context: readonly string[];
  readonly line: number;
};

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

type CssWalk = {
  readonly decls: CssDecl[];
  readonly blocks: CssBlock[];
  /** The walk ended inside a string, a block, or a half-read declaration. */
  readonly unterminated: boolean;
};

const walkCss = (source: string): CssWalk => {
  const decls: CssDecl[] = [];
  const blocks: CssBlock[] = [];
  const stack: string[] = [];
  let buf = "";
  let bufLine = 1;
  let line = 1;
  let paren = 0;
  let quote: string | null = null;
  const append = (text: string) => {
    if (buf.trim() === "" && text.trim() !== "") bufLine = line;
    buf += text;
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      buf += ch;
      if (ch === "\\") {
        buf += source[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      if (ch === "\n") line += 1;
      continue;
    }
    // An escape outside a string: Tailwind escapes the class name into the
    // selector (`.before\:content-\[\'–\'\]`), so a `\'` here must not open a
    // string — the walk would then swallow the rest of the stylesheet.
    if (ch === "\\") {
      append(ch + (source[i + 1] ?? ""));
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k += 1) if (source[k] === "\n") line += 1;
      buf += " ";
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      append(ch);
      continue;
    }
    if (ch === "(") paren += 1;
    if (ch === ")") paren = Math.max(0, paren - 1);
    if (paren === 0 && (ch === "{" || ch === ";" || ch === "}")) {
      const text = buf.trim();
      if (ch === "{") {
        const prelude = collapse(text);
        blocks.push({ prelude, context: [...stack], line: bufLine });
        stack.push(prelude);
      } else if (text !== "" && !text.startsWith("@")) {
        const colon = text.indexOf(":");
        if (colon > 0) {
          decls.push({
            prop: text.slice(0, colon).trim(),
            value: collapse(text.slice(colon + 1)),
            context: [...stack],
            line: bufLine,
          });
        }
      }
      if (ch === "}") stack.pop();
      buf = "";
      continue;
    }
    append(ch);
    if (ch === "\n") line += 1;
  }
  return {
    decls,
    blocks,
    unterminated: quote !== null || stack.length > 0 || buf.trim() !== "",
  };
};

// ---------------------------------------------------------------------------
// What counts as a raw value. Mirrors the allowlist in tokens.md.

// CSS named colors, minus the keywords that choose no color.
const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);
const COLOR_FUNCTION =
  /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const HEX_COLOR = /(?<![\w&-])#[0-9a-f]{3,8}(?![\w-])/i;

const LENGTH_UNITS = new Set(
  "px rem em ex ch cap ic rlh lh vw vh vi vb vmin vmax dvw dvh dvi dvb svw svh svi svb lvw lvh lvi lvb cqw cqh cqi cqb cqmin cqmax cm mm q in pt pc".split(
    " ",
  ),
);
// Relative units carry no chosen length: `%`, viewport units, `fr`, `lh`.
const RELATIVE_UNITS = new Set(
  "% vw vh vi vb vmin vmax dvw dvh dvi dvb svw svh svi svb lvw lvh lvi lvb fr lh".split(
    " ",
  ),
);
const TIME_UNITS = new Set(["s", "ms"]);
const TIMING_KEYWORD =
  /(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w-])|(?:cubic-bezier|steps|linear)\(/;
const UNITLESS_RESTRICTED = new Set([
  "font-weight",
  "line-height",
  "font",
  "--tw-font-weight",
  "--tw-leading",
]);
const TIMING_PROPS = new Set([
  "transition",
  "transition-timing-function",
  "transition-duration",
  "animation",
  "animation-timing-function",
  "animation-duration",
  "--tw-ease",
  "--tw-duration",
]);
const OUTLINE_PROPS = new Set(["outline", "outline-width", "outline-offset"]);
const NUMBER =
  /(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+|%)?(?![\w-])/gi;

const withoutStrings = (value: string): string =>
  value
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/url\([^)]*\)/gi, "url()")
    .replace(/!important/gi, "");

/** Raw colors in a declaration value. */
const rawColors = (value: string): string[] => {
  const v = withoutStrings(value);
  const found: string[] = [];
  const fn = COLOR_FUNCTION.exec(v);
  if (fn) found.push(`${fn[0]}…)`);
  const hex = HEX_COLOR.exec(v);
  if (hex) found.push(hex[0]);
  for (const word of v.match(/(?<![\w-])[a-z]+(?![\w(-])/gi) ?? []) {
    if (NAMED_COLORS.has(word.toLowerCase())) found.push(word);
  }
  return found;
};

/**
 * Raw values in a declaration outside the allowlist: colors, plus lengths,
 * times, unitless weights / line-heights, typefaces and timing functions.
 */
const rawValues = (prop: string, value: string): string[] => {
  const found = rawColors(value);
  const p = prop.toLowerCase();
  const v = withoutStrings(value);
  if (
    (p === "font-family" || p === "--tw-font-family") &&
    !/^(?:var\(--[\w-]+\)|inherit|initial|unset|revert)$/.test(v.trim())
  ) {
    found.push(v.trim());
  }
  if (TIMING_PROPS.has(p) && TIMING_KEYWORD.test(v)) {
    found.push((TIMING_KEYWORD.exec(v) ?? [""])[0]);
  }
  for (const [text, num, rawUnit] of v.matchAll(NUMBER)) {
    const unit = (rawUnit ?? "").toLowerCase();
    if (Number(num) === 0) continue;
    if (unit === "") {
      if (UNITLESS_RESTRICTED.has(p)) found.push(text);
      continue;
    }
    if (TIME_UNITS.has(unit)) {
      found.push(text);
      continue;
    }
    if (!LENGTH_UNITS.has(unit)) continue;
    if (RELATIVE_UNITS.has(unit)) continue;
    if (unit === "px" && Math.abs(Number(num)) === 1) continue;
    if (unit === "px" && Math.abs(Number(num)) === 2 && OUTLINE_PROPS.has(p))
      continue;
    if (unit === "em" && p.startsWith("margin")) continue;
    found.push(text);
  }
  return found;
};

/**
 * Lengths in an at-rule's prelude that are not one of the breakpoints. Every
 * conditional at-rule is read, not only `@media`: the same raw length reaches
 * the stylesheet through `@container` (`@[500px]:p-md`) and through
 * `@supports` (`supports-[width:13px]:p-md`). `@keyframes` is out, as the
 * allowlist puts its steps out.
 */
const rawPreludeLengths = (
  prelude: string,
  breakpoints: ReadonlySet<string>,
): string[] => {
  if (!prelude.startsWith("@") || prelude.startsWith("@keyframes")) return [];
  return [...prelude.matchAll(NUMBER)]
    .filter(([, num, unit]) => unit !== undefined && Number(num) !== 0)
    .map(([text]) => text)
    .filter((text) => !breakpoints.has(text));
};

// A class selector in a hand-written rule is the second way a look could be
// redefined from outside the component that owns it: `styles/` holds
// the tokens, the theme projection and the base layer, and names no class.
// `@keyframes` steps (`from` / `to` / `50%`) are not selectors.
const CLASS_SELECTOR = /(?<![\w\\-])\.-?[_a-z]/i;
const classSelectors = (blocks: readonly CssBlock[]): CssBlock[] =>
  blocks.filter(
    (b) =>
      !b.prelude.startsWith("@") &&
      !b.context.some((c) => c.startsWith("@keyframes")) &&
      CLASS_SELECTOR.test(b.prelude),
  );

const FALLBACK = /var\(\s*--[\w-]+\s*,/;
const VAR_REF = /var\(\s*(--[\w-]+)/g;
const varRefs = (value: string): string[] =>
  [...value.matchAll(VAR_REF)].map(([, name]) => name);

// ---------------------------------------------------------------------------
// Tokens: tokens.md's code blocks are the source, `tokens.css` the copy.

const normalizeValue = (value: string): string =>
  collapse(value)
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();

const customProps = (decls: readonly CssDecl[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const d of decls) {
    if (d.prop.startsWith("--")) out.set(d.prop, normalizeValue(d.value));
  }
  return out;
};

const duplicates = (decls: readonly CssDecl[]): string[] => {
  const seen = new Set<string>();
  return decls
    .map((d) => d.prop)
    .filter((p) => p.startsWith("--"))
    .filter((p) => {
      if (seen.has(p)) return true;
      seen.add(p);
      return false;
    });
};

const tokensMdDecls = (): CssDecl[] => {
  const md = readFileSync(TOKENS_MD, "utf8");
  const blocks = [...md.matchAll(/```css\n([\s\S]*?)```/g)].map(([, b]) => b);
  return walkCss(blocks.join("\n")).decls;
};

const styleFiles = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .sort();
const styleSource = new Map(
  styleFiles.map((f) => [f, readFileSync(join(STYLES, f), "utf8")]),
);
const styleWalk = new Map(
  styleFiles.map((f) => [f, walkCss(styleSource.get(f) ?? "")]),
);
const walked = (file: string) => {
  const w = styleWalk.get(file);
  if (w === undefined) throw new Error(`styles/${file} is missing`);
  return w;
};

const tokenDecls = walked(TOKENS_CSS).decls;
const tokens = customProps(tokenDecls);
const themeDecls = walked(THEME_CSS).decls.filter(
  (d) => d.context[0] === "@theme",
);
const themeVars = new Map(
  themeDecls.filter((d) => d.prop.startsWith("--")).map((d) => [d.prop, d]),
);
const breakpointValues = new Set(
  [...tokens].filter(([name]) => name.startsWith("--bp-")).map(([, v]) => v),
);

// Tokens that theme.css hands to a namespace: consuming one as `(--token)`
// bypasses the utility name that exists for it.
const projectedTokens = new Set(
  themeDecls.flatMap((d) =>
    d.prop.startsWith("--breakpoint-") || d.prop.startsWith("--animate-")
      ? []
      : varRefs(d.value),
  ),
);

const where = (file: string, line: number) => `styles/${file}:${line}`;

// ---------------------------------------------------------------------------
// The generated utilities, from the same inputs `@tailwindcss/vite` uses: the
// entry stylesheet compiled from its own directory, and the scanner over the
// Vite root (`apps/web`) plus any `@source`.

const compiled = await compile(styleSource.get(ENTRY_CSS) ?? "", {
  base: STYLES,
  onDependency: () => {},
});
const scanner = new Scanner({
  sources: [
    ...(compiled.root === "none"
      ? []
      : compiled.root === null
        ? [{ base: WEB_ROOT, pattern: "**/*", negated: false }]
        : [{ ...compiled.root, negated: false }]),
    ...compiled.sources,
  ],
});
const allCandidates = scanner.scan();
const generatedCss = compiled.build(allCandidates);
const generated = walkCss(generatedCss);

const UTILITIES_LAYER = "@layer utilities";

const unescapeCss = (text: string): string =>
  text
    .replace(/\\([0-9a-f]{1,6}) ?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, "$1");

const candidateSet = new Set(allCandidates);
const candidatesOfSelector = (selector: string): string[] =>
  [...selector.matchAll(/\.((?:\\[0-9a-f]{1,6} ?|\\.|[\w-])+)/gi)]
    .map(([, cls]) => unescapeCss(cls))
    .filter((c) => candidateSet.has(c));

// Candidate → the rule it generated, for every utility Tailwind emitted.
const utilityDecls = generated.decls
  .filter((d) => d.context[0] === UTILITIES_LAYER && d.context.length >= 2)
  .map((d) => ({
    ...d,
    candidates: [...new Set(d.context.slice(1).flatMap(candidatesOfSelector))],
  }));
const utilityBlocks = generated.blocks.filter(
  (b) => b.context[0] === UTILITIES_LAYER,
);
const validCandidates = new Set(utilityDecls.flatMap((d) => d.candidates));

// Which files a candidate came from, for failure messages and for the rules
// that depend on where a className is written.
const SOURCE_EXT = new Set([".ts", ".tsx"]);
const candidateFiles = new Map<string, Set<string>>();
// `pluginWiring.test.ts` writes and deletes a fixture under `apps/web/app/`
// while this file may be running in a parallel worker, so a scanned file can be
// gone by the time it is read.
const readIfPresent = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
for (const file of scanner.files) {
  const content = readIfPresent(file);
  if (content === null) continue;
  for (const { candidate } of scanner.getCandidatesWithPositions({
    content,
    extension: extname(file).slice(1),
  })) {
    if (!validCandidates.has(candidate)) continue;
    const files = candidateFiles.get(candidate) ?? new Set<string>();
    files.add(relative(REPO_ROOT, file));
    candidateFiles.set(candidate, files);
  }
}
const origin = (candidate: string): string =>
  [...(candidateFiles.get(candidate) ?? [])].join(", ") || "unknown source";

/** Every `.ts` / `.tsx` under a directory, for the scans that read prose. */
const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFilesUnder(path);
    }
    return SOURCE_EXT.has(extname(entry.name)) ? [path] : [];
  });

const isAppSource = (path: string): boolean =>
  SOURCE_EXT.has(extname(path)) &&
  path.startsWith(relative(REPO_ROOT, APP_ROOT) + sep) &&
  !path.split(sep).includes("__tests__") &&
  !/\.(test|spec)\.tsx?$/.test(path) &&
  !path.endsWith(".tmp.ts");
const isInsideUi = (path: string): boolean =>
  path.startsWith(relative(REPO_ROOT, UI_ROOT) + sep);

// ---------------------------------------------------------------------------
// Candidate grammar: `variant:variant:utility`, split outside brackets.

const splitTopLevel = (text: string, separator: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
};

const combinatorsAtTopLevel = (selector: string): string[] => {
  const found: string[] = [];
  let depth = 0;
  const s = selector.trimEnd();
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    if (ch === ">" || ch === "+" || ch === "~") found.push(ch);
    else if (ch === " ") found.push("descendant");
  }
  return found;
};

// The part of a selector that follows `&`: a combinator there means the rule
// lands on some other element, not the one carrying the class. `.dark &` keeps
// the subject; `& p` / `& > *` / `& + *` move it.
const selectorCombinators = (selector: string): string[] => {
  const amp = selector.lastIndexOf("&");
  return combinatorsAtTopLevel(
    amp === -1 ? ` ${selector}` : selector.slice(amp + 1),
  );
};

// The same question asked of an arbitrary variant, whose selector is written
// in the className: `[.dark_&]` keeps the subject; `[&_p]` / `[&>*]` / `[&+*]`
// move it.
const targetCombinators = (variant: string): string[] => {
  if (!variant.startsWith("[") || !variant.endsWith("]")) return [];
  const selector = variant.slice(1, -1).replaceAll("_", " ");
  if (selector.startsWith("@")) return [];
  return selectorCombinators(selector);
};

// A `@custom-variant` / `@utility` names a selector, and the name is all a
// className then shows — so `targetCombinators`, which reads the selector out
// of the className, sees nothing of where the rule lands. The definitions are
// written in `styles/`, and these read them there: the inline form
// (`@custom-variant name (& + *);`) by its text, the block form
// (`@utility name { & p { … } }`) by the preludes nested under it.
const INLINE_CUSTOM_VARIANT = /@custom-variant\s+([^\s({]+)\s*\(([^)]*)\)/g;
const DEFINITION_AT_RULE = /^@(?:custom-variant|utility)\b/;

const definedVariantNames = (source: string): string[] =>
  [...source.matchAll(/@custom-variant\s+([^\s({]+)/g)].map(([, name]) => name);

/** Selectors `styles/` names, minus the one declared sibling variant. */
const namedSelectors = (file: string): string[] => [
  ...[...(styleSource.get(file) ?? "").matchAll(INLINE_CUSTOM_VARIANT)]
    .filter(([, name]) => name !== NEXT_SIBLING_VARIANT)
    .map(([, , selector]) => selector),
  ...walked(file)
    .blocks.filter((b) => b.context.some((c) => DEFINITION_AT_RULE.test(c)))
    .map((b) => b.prelude),
];

// Built-in variants and utilities whose rule lands on other elements.
const OTHER_ELEMENT_VARIANTS = new Set(["*", "**", "marker", "selection"]);
const CHILD_TARGETING_UTILITY = /^!?-?(?:space-[xy]|divide)(?:-|$)/;

/** Why a candidate outside `components/ui` would restyle another element. */
const overridePath = (candidate: string): string | null => {
  const parts = splitTopLevel(candidate, ":");
  const utility = parts.pop() ?? "";
  for (const variant of parts) {
    if (OTHER_ELEMENT_VARIANTS.has(variant)) return `variant \`${variant}:\``;
    const combinators = targetCombinators(variant);
    if (combinators.length > 0) return `variant \`${variant}:\``;
  }
  if (CHILD_TARGETING_UTILITY.test(utility)) return `utility \`${utility}\``;
  return null;
};

/** Why a candidate breaks the sibling rule (anywhere, `components/ui` too). */
const siblingMisuse = (candidate: string): string | null => {
  const parts = splitTopLevel(candidate, ":");
  const utility = parts.pop() ?? "";
  for (const variant of parts) {
    const combinators = targetCombinators(variant);
    if (combinators.includes("+") || combinators.includes("~")) {
      return `\`${variant}:\` — use \`${NEXT_SIBLING_VARIANT}:mt-*\``;
    }
    if (variant === NEXT_SIBLING_VARIANT && !/^mt-[\w-]+$/.test(utility)) {
      return `\`${NEXT_SIBLING_VARIANT}:\` carries only \`mt-*\`, not \`${utility}\``;
    }
  }
  return null;
};

/**
 * Token names a candidate reads as `(--token)` or a bare `[var(--token)]`,
 * including the typed forms Tailwind also accepts (`(length:--token)` /
 * `[length:var(--token)]`).
 */
const tokenReferences = (candidate: string): string[] => [
  ...[...candidate.matchAll(/(?<!var)\((?:[\w-]+:)?(--[\w-]+)\)/g)].map(
    ([, name]) => name,
  ),
  ...[...candidate.matchAll(/\[(?:[\w-]+:)?var\((--[\w-]+)\)\]/g)].map(
    ([, name]) => name,
  ),
];

// ===========================================================================

describe("design tokens — tokens.css is tokens.md's copy", () => {
  const mdDecls = tokensMdDecls();
  const md = customProps(mdDecls);

  it("parses a non-empty token set from both files", () => {
    expect(md.size).toBeGreaterThan(50);
    expect(tokens.size).toBeGreaterThan(50);
  });

  it("declares each token once", () => {
    expect(duplicates(mdDecls), "duplicated in tokens.md").toEqual([]);
    expect(duplicates(tokenDecls), "duplicated in tokens.css").toEqual([]);
  });

  it("has the same token names", () => {
    expect(
      [...md.keys()].filter((n) => !tokens.has(n)),
      "in tokens.md but not in styles/tokens.css",
    ).toEqual([]);
    expect(
      [...tokens.keys()].filter((n) => !md.has(n)),
      "in styles/tokens.css but not in tokens.md — add it to tokens.md (with its role) or drop it",
    ).toEqual([]);
  });

  it("has the same value for every token", () => {
    const differing = [...md]
      .filter(([name, value]) => tokens.has(name) && tokens.get(name) !== value)
      .map(
        ([name, value]) =>
          `${name}: tokens.md \`${value}\` ≠ tokens.css \`${tokens.get(name)}\``,
      );
    expect(differing).toEqual([]);
  });

  it("declares tokens only on :root", () => {
    expect(
      tokenDecls
        .filter((d) => d.context.join(" ") !== ":root")
        .map(
          (d) => `${d.prop} under ${d.context.join(" > ") || "(top level)"}`,
        ),
    ).toEqual([]);
  });
});

describe("design tokens — references", () => {
  const defined = new Set<string>([
    ...tokens.keys(),
    ...themeVars.keys(),
    ...styleFiles.flatMap((f) =>
      walked(f)
        .decls.filter((d) => d.prop.startsWith("--"))
        .map((d) => d.prop),
    ),
  ]);

  it("has no var() fallback under styles/", () => {
    const found = styleFiles.flatMap((f) =>
      walked(f)
        .decls.filter((d) => FALLBACK.test(d.value))
        .map((d) => `${where(f, d.line)} ${d.prop}: ${d.value}`),
    );
    expect(found, "drop the fallback: every token is defined").toEqual([]);
  });

  it("references only defined custom properties under styles/", () => {
    const found = styleFiles.flatMap((f) =>
      walked(f).decls.flatMap((d) =>
        varRefs(d.value)
          .filter((name) => !defined.has(name))
          .map((name) => `${where(f, d.line)} ${name}`),
      ),
    );
    expect(found).toEqual([]);
  });

  it("projects only tokens into the theme", () => {
    const found = themeDecls
      .filter(
        (d) =>
          !d.context.some((c) => c.startsWith("@keyframes")) &&
          !d.prop.startsWith("--breakpoint-") &&
          !d.prop.startsWith("--animate-") &&
          !/^(?:initial|var\(--[\w-]+\))$/.test(d.value),
      )
      .map((d) => `${where(THEME_CSS, d.line)} ${d.prop}: ${d.value}`);
    expect(found, "theme.css holds no value of its own").toEqual([]);
    expect(
      themeDecls.filter((d) => d.prop === "--*" && d.value === "initial"),
      "theme.css must drop Tailwind's default theme with `--*: initial`",
    ).toHaveLength(1);
  });

  it("uses tokens.md's breakpoints in the theme", () => {
    const themeBreakpoints = themeDecls
      .filter((d) => d.prop.startsWith("--breakpoint-"))
      .map((d) => [d.prop.slice("--breakpoint-".length), d.value]);
    const tokenBreakpoints = [...tokens]
      .filter(([name]) => name.startsWith("--bp-"))
      .map(([name, value]) => [name.slice("--bp-".length), value]);
    expect(tokenBreakpoints.length).toBeGreaterThan(0);
    expect(themeBreakpoints).toEqual(tokenBreakpoints);
  });

  it("references only generated-or-declared custom properties from the utilities", () => {
    const found = utilityDecls.flatMap((d) =>
      varRefs(d.value)
        .filter((name) => !defined.has(name) && !name.startsWith("--tw-"))
        .map(
          (name) =>
            `${d.candidates.join(" ")} → ${name} (${d.candidates.map(origin).join("; ")})`,
        ),
    );
    expect(found).toEqual([]);
  });

  // A citation sends the reader to `spec/adr/` wherever it is written, so the
  // scan covers the app's sources and these checks as well as `styles/`.
  it("cites only ADRs that exist in spec/adr/", () => {
    const adrs = new Set(
      readdirSync(ADR_DIR)
        .map((f) => /^(\d+)-/.exec(f)?.[1])
        .filter((n): n is string => n !== undefined),
    );
    const citing = [
      ...styleFiles.map((f) => ({
        label: `styles/${f}`,
        source: styleSource.get(f) ?? "",
      })),
      ...[...sourceFilesUnder(APP_ROOT), ...sourceFilesUnder(LINT_DIR)].map(
        (path) => ({
          label: relative(REPO_ROOT, path),
          source: readIfPresent(path) ?? "",
        }),
      ),
    ];
    const found = citing.flatMap(({ label, source }) =>
      [...source.matchAll(/ADR-(\d+)/g)]
        .filter(([, n]) => !adrs.has(n.padStart(3, "0")))
        .map(([cited]) => `${label}: ${cited}`),
    );
    expect(found).toEqual([]);
  });
});

describe("design tokens — no raw value outside tokens.css", () => {
  const inKeyframes = (d: CssDecl) =>
    d.context.some((c) => c.startsWith("@keyframes"));
  const themeException = (file: string, d: CssDecl) =>
    file === THEME_CSS &&
    (d.prop.startsWith("--animate-") || d.prop.startsWith("--breakpoint-"));

  it("has no raw color in the hand-written CSS", () => {
    const found = styleFiles
      .filter((f) => f !== TOKENS_CSS)
      .flatMap((f) =>
        walked(f)
          .decls.filter((d) => !inKeyframes(d))
          .flatMap((d) =>
            rawColors(d.value).map(
              (c) => `${where(f, d.line)} ${d.prop}: ${c}`,
            ),
          ),
      );
    expect(found, "use a --color-* token").toEqual([]);
  });

  it("has no raw value outside the allowlist in the hand-written CSS", () => {
    const found = styleFiles
      .filter((f) => f !== TOKENS_CSS)
      .flatMap((f) => [
        ...walked(f)
          .decls.filter((d) => !inKeyframes(d) && !themeException(f, d))
          .flatMap((d) =>
            rawValues(d.prop, d.value).map(
              (r) => `${where(f, d.line)} ${d.prop}: ${r}`,
            ),
          ),
        ...walked(f).blocks.flatMap((b) =>
          rawPreludeLengths(b.prelude, breakpointValues).map(
            (r) => `${where(f, b.line)} ${b.prelude}: ${r}`,
          ),
        ),
      ]);
    expect(found).toEqual([]);
  });

  it("generates utilities (the scan is not vacuous)", () => {
    expect(allCandidates.length).toBeGreaterThan(0);
    expect(utilityDecls.length).toBeGreaterThan(0);
    expect(validCandidates.has("sr-only")).toBe(true);
  });

  // A walk that stops early leaves every check that reads it green over a
  // fraction of the stylesheet, which the check above cannot tell from a full
  // pass.
  it("walks each stylesheet to its end", () => {
    expect(generated.unterminated, "the generated CSS").toBe(false);
    expect(styleFiles.filter((f) => walked(f).unterminated)).toEqual([]);
    expect(
      utilityBlocks.filter((b) => b.prelude.startsWith("@media")).length,
      "the variants that compile to `@media` (`hover:`, `lg:`) must be reached",
    ).toBeGreaterThan(0);
  });

  it("generates no utility with a raw value outside the allowlist", () => {
    const found = [
      ...utilityDecls.flatMap((d) =>
        rawValues(d.prop, d.value).map(
          (r) =>
            `\`${d.candidates.join(" ")}\` → ${d.prop}: ${r} (${d.candidates.map(origin).join("; ")})`,
        ),
      ),
      ...utilityBlocks.flatMap((b) =>
        rawPreludeLengths(b.prelude, breakpointValues).map(
          (r) => `${b.prelude}: ${r} under ${b.context.join(" > ")}`,
        ),
      ),
    ];
    expect(
      found,
      "use a token utility (`p-md`, `text-sm`, `rounded-lg`); an arbitrary value or bare number is a raw value",
    ).toEqual([]);
  });

  // `--*: initial` is what keeps these from existing at all; without it the
  // check above only fires once a source happens to use one.
  it("does not generate Tailwind's default scale", async () => {
    const probe = await compile(styleSource.get(ENTRY_CSS) ?? "", {
      base: STYLES,
      onDependency: () => {},
    });
    const defaults = [
      "p-4",
      "w-96",
      "bg-red-500",
      "rounded-xl",
      "max-w-7xl",
      "text-7xl",
      "font-mono",
      "shadow-2xl",
      "leading-relaxed",
      "tracking-wide",
      "ease-in-out",
      "animate-pulse",
      "container",
    ];
    const css = probe.build([...defaults, "p-md"]);
    expect(defaults.filter((c) => css.includes(`.${c} {`))).toEqual([]);
    expect(css).toContain(".p-md {");
  });
});

describe("design tokens — the utilities read tokens by their utility name", () => {
  it("reads no projected token as `(--token)`", () => {
    const found = [...validCandidates].flatMap((c) =>
      tokenReferences(c)
        .filter((name) => projectedTokens.has(name) || themeVars.has(name))
        .map((name) => `\`${c}\` reads ${name} (${origin(c)})`),
    );
    expect(
      found,
      "use the utility name theme.css projects the token to; `(--token)` is for tokens no namespace carries",
    ).toEqual([]);
  });
});

describe("design tokens — no override path onto a primitive", () => {
  const appCandidates = [...candidateFiles].flatMap(([candidate, files]) =>
    [...files].filter(isAppSource).map((file) => ({ candidate, file })),
  );

  it("finds className candidates in app sources", () => {
    expect(appCandidates.length).toBeGreaterThan(0);
  });

  it("targets no other element from outside components/ui", () => {
    const found = appCandidates
      .filter(({ file }) => !isInsideUi(file))
      .flatMap(({ candidate, file }) => {
        const why = overridePath(candidate);
        return why === null ? [] : [`${file}: \`${candidate}\` (${why})`];
      });
    expect(
      found,
      "style the element itself; a primitive's look changes by its props, not from a wrapper",
    ).toEqual([]);
  });

  it("targets a sibling only through next-sibling:mt-*", () => {
    const found = appCandidates.flatMap(({ candidate, file }) => {
      const why = siblingMisuse(candidate);
      return why === null ? [] : [`${file}: \`${candidate}\` (${why})`];
    });
    expect(found).toEqual([]);
  });

  it("names no class in the hand-written CSS", () => {
    const found = styleFiles.flatMap((f) =>
      classSelectors(walked(f).blocks).map(
        (b) => `${where(f, b.line)} ${b.prelude}`,
      ),
    );
    expect(
      found,
      "a look belongs to the element's className; styles/ carries only the tokens, the theme projection and the base layer",
    ).toEqual([]);
  });

  it("defines the next-sibling variant in index.css and no other name", () => {
    expect(styleSource.get(ENTRY_CSS)).toContain(
      `@custom-variant ${NEXT_SIBLING_VARIANT} (& + *);`,
    );
    expect(
      styleFiles.flatMap((f) =>
        definedVariantNames(styleSource.get(f) ?? "").map(
          (name) => `styles/${f}: ${name}`,
        ),
      ),
      "a second named variant reopens the override path: the className shows the name, not the selector",
    ).toEqual([`styles/${ENTRY_CSS}: ${NEXT_SIBLING_VARIANT}`]);
    expect(
      styleFiles.flatMap((f) =>
        namedSelectors(f)
          .filter((selector) => selectorCombinators(selector).length > 0)
          .map((selector) => `styles/${f}: ${selector}`),
      ),
      "a named variant or utility styles the element it is put on; `next-sibling:mt-*` is the one exception",
    ).toEqual([]);
    // The scan above reads the `styles/` files themselves, so a name defined
    // in CSS pulled in from outside them, or registered from a plugin's JS —
    // whether the plugin is named directly or reached through a JS config —
    // would be invisible to it.
    expect(
      styleFiles.flatMap((f) =>
        [
          ...(styleSource.get(f) ?? "").matchAll(
            /@(?:import|plugin|config)\s+[^;{]+/g,
          ),
        ].map((m) => `styles/${f}: ${collapse(m[0])}`),
      ),
      "a fourth path would be a variant defined outside `styles/`: CSS read in by `@import`, or a `@plugin` / `@config` registering one from JS",
    ).toEqual([
      `styles/${ENTRY_CSS}: @import "tailwindcss"`,
      `styles/${ENTRY_CSS}: @import "./${TOKENS_CSS}"`,
      `styles/${ENTRY_CSS}: @import "./${THEME_CSS}"`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Class names that reach no stylesheet. With Tailwind's default theme dropped,
// a name that reads a scale the tokens do not carry — `min-w-0`,
// `p-0`, `gap-0` — is not an error: it simply generates nothing, and the
// declaration it was meant to write is silently missing (the zero a component
// does mean is written as an arbitrary value).
//
// The class lists are read from the sources rather than from the scan, because
// the scanner offers prose words as candidates too: a string literal counts as
// a class list when every token is candidate-shaped and at least one of them
// does generate CSS. Out of reach: a class string of a single token, and a
// class name assembled at runtime (which never becomes CSS either).

const probeBaseline = (
  await compile(styleSource.get(ENTRY_CSS) ?? "", {
    base: STYLES,
    onDependency: () => {},
  })
).build([]);

const generatesCss = async (candidate: string): Promise<boolean> => {
  if (validCandidates.has(candidate)) return true;
  const probe = await compile(styleSource.get(ENTRY_CSS) ?? "", {
    base: STYLES,
    onDependency: () => {},
  });
  return probe.build([candidate]) !== probeBaseline;
};

// Tailwind's marker classes: they name the subject of a `group-*` / `peer-*`
// variant and carry no declaration of their own.
const MARKER_CLASSES = /^(?:group|peer)(?:\/[\w-]+)?$/;

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const STRING_LITERAL = /"([^"\\\n]*)"|'([^'\\\n]*)'|`((?:[^`\\$]|\$(?!\{))*)`/g;
const INTERPOLATION = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g;
// A token is candidate-shaped when it opens the way a utility does — `@` among
// them, since a container-query variant (`@lg:p-md`) opens with it and a class
// list holding one is still a class list. SVG path data (`M118`, `-107.5Q441`,
// `4.5v3.7`) and sentences do not.
const CANDIDATE_TOKEN = /^(?:-?[a-z]|\[|!|@)\S*$/;

/** The tokens of a string literal, dropping the halves an `${…}` splits. */
const literalTokens = (raw: string): string[] => {
  const chunks = raw.split(INTERPOLATION);
  return chunks.flatMap((chunk, index) => {
    const parts = chunk.split(/\s+/);
    if (index > 0 && !/^\s/.test(chunk)) parts.shift();
    if (index < chunks.length - 1 && !/\s$/.test(chunk)) parts.pop();
    return parts.filter((part) => part !== "");
  });
};

describe("design tokens — every class name reaches the stylesheet", () => {
  it("generates CSS for every token of every class list", async () => {
    const found: string[] = [];
    for (const file of scanner.files) {
      const rel = relative(REPO_ROOT, file);
      if (!isAppSource(rel)) continue;
      const source = stripComments(readIfPresent(file) ?? "");
      for (const match of source.matchAll(STRING_LITERAL)) {
        const tokens = literalTokens(match[1] ?? match[2] ?? match[3] ?? "");
        if (tokens.length < 2) continue;
        if (!tokens.every((t) => CANDIDATE_TOKEN.test(t))) continue;
        const dead: string[] = [];
        let live = 0;
        for (const token of tokens) {
          if (MARKER_CLASSES.test(token)) continue;
          if (await generatesCss(token)) live += 1;
          else dead.push(token);
        }
        if (live === 0) continue;
        found.push(...dead.map((token) => `${rel}: \`${token}\``));
      }
    }
    expect(
      [...new Set(found)].sort(),
      "this class name generates no CSS — write a value 0 as `[0]` and every other value with a token utility",
    ).toEqual([]);
  });

  it("knows a live utility from a dead one", async () => {
    expect(await generatesCss("p-md")).toBe(true);
    expect(await generatesCss("min-w-[0]")).toBe(true);
    expect(await generatesCss("sr-only")).toBe(true);
    expect(await generatesCss("min-w-0")).toBe(false);
    expect(await generatesCss("p-0")).toBe(false);
    expect(await generatesCss("gap-0")).toBe(false);
  });

  it("reads a class list off a literal and leaves prose alone", () => {
    // Assembled rather than written out: a `${…}` inside a literal here is
    // the fixture, not this file's own interpolation.
    const hole = (expression: string) => `$\{${expression}}`;
    expect(literalTokens("min-w-[0] flex-1")).toEqual(["min-w-[0]", "flex-1"]);
    expect(literalTokens(`block w-full ${hole("DOC_TITLE_CLASS")}`)).toEqual([
      "block",
      "w-full",
    ]);
    expect(literalTokens(`${hole("SIZE_CLASS[size]")} shrink-0`)).toEqual([
      "shrink-0",
    ]);
    expect(literalTokens(`text-${hole("size")} p-md`)).toEqual(["p-md"]);
    expect(CANDIDATE_TOKEN.test("before:content-['–']")).toBe(true);
    expect(CANDIDATE_TOKEN.test("@lg:p-md")).toBe(true);
    expect(CANDIDATE_TOKEN.test("M118")).toBe(false);
    expect(CANDIDATE_TOKEN.test("-107.5Q441")).toBe(false);
  });
});

// The detectors' own reach, independent of what the repository holds today.
describe("design tokens — what the checks reach", () => {
  it("flags raw colors and lets keywords through", () => {
    expect(rawColors("#fff")).toEqual(["#fff"]);
    expect(rawColors("rgba(255, 255, 255, 0.25)")).toHaveLength(1);
    expect(rawColors("1px solid white")).toEqual(["white"]);
    expect(
      rawColors("color-mix(in oklab, var(--color-overlay) 50%, transparent)"),
    ).toHaveLength(1);
    expect(rawColors("transparent")).toEqual([]);
    expect(rawColors("currentColor")).toEqual([]);
    expect(rawColors("var(--color-primary)")).toEqual([]);
    expect(rawColors("var(--tw-ring-color, currentcolor)")).toEqual([]);
    expect(rawColors("nowrap")).toEqual([]);
  });

  it("flags raw lengths, times, weights and typefaces outside the allowlist", () => {
    expect(rawValues("padding", "13px")).toEqual(["13px"]);
    expect(rawValues("padding", "calc(var(--spacing) * 4)")).toEqual([]);
    expect(rawValues("border-width", "3px")).toEqual(["3px"]);
    expect(rawValues("transition-duration", "300ms")).toContain("300ms");
    expect(rawValues("--tw-ease", "linear")).toEqual(["linear"]);
    expect(rawValues("line-height", "1")).toEqual(["1"]);
    expect(rawValues("font-weight", "700")).toEqual(["700"]);
    expect(rawValues("font-family", "ui-monospace, monospace")).toHaveLength(1);
    expect(rawValues("margin-top", "0.5rem")).toEqual(["0.5rem"]);
    expect(rawValues("border-radius", "0.25rem")).toEqual(["0.25rem"]);
    expect(
      rawValues("--tw-shadow", "0 1px 3px 0 var(--tw-shadow-color)"),
    ).toEqual(["3px"]);
  });

  it("lets the allowlist through", () => {
    expect(
      rawValues("border-top", "1px solid var(--color-neutral-100)"),
    ).toEqual([]);
    expect(rawValues("margin", "-1px")).toEqual([]);
    expect(rawValues("outline", "2px solid var(--color-focus)")).toEqual([]);
    expect(rawValues("outline-offset", "-2px")).toEqual([]);
    expect(rawValues("padding", "2px")).toEqual(["2px"]);
    expect(rawValues("width", "calc(5 / 6 * 100%)")).toEqual([]);
    expect(rawValues("height", "100dvh")).toEqual([]);
    expect(rawValues("max-height", "6lh")).toEqual([]);
    expect(rawValues("grid-template-columns", "1fr 2fr")).toEqual([]);
    expect(rawValues("margin-top", "1.3em")).toEqual([]);
    expect(rawValues("padding-top", "1.3em")).toEqual(["1.3em"]);
    expect(rawValues("transform", "rotate(90deg)")).toEqual([]);
    expect(rawValues("font-family", "var(--font-base)")).toEqual([]);
    expect(
      rawValues(
        "transition-duration",
        "var(--tw-duration, var(--default-transition-duration))",
      ),
    ).toEqual([]);
    expect(rawValues("padding", "var(--space-md)")).toEqual([]);
    expect(rawValues("z-index", "10")).toEqual([]);
    expect(rawValues("padding", "0 0px 0rem")).toEqual([]);
  });

  it("checks every at-rule prelude against the breakpoints", () => {
    const bp = new Set(["640px", "1024px"]);
    expect(rawPreludeLengths("@media (width >= 640px)", bp)).toEqual([]);
    expect(rawPreludeLengths("@media (width >= 500px)", bp)).toEqual(["500px"]);
    expect(rawPreludeLengths("@container (width >= 500px)", bp)).toEqual([
      "500px",
    ]);
    expect(rawPreludeLengths("@supports (width: 13px)", bp)).toEqual(["13px"]);
    expect(rawPreludeLengths("@media (hover: hover)", bp)).toEqual([]);
    expect(rawPreludeLengths("@layer utilities", bp)).toEqual([]);
    expect(rawPreludeLengths("@keyframes spin", bp)).toEqual([]);
    expect(rawPreludeLengths(".w-[13px]", bp)).toEqual([]);
  });

  it("finds a class selector and leaves element and keyframe rules alone", () => {
    const { blocks } = walkCss(
      "@layer base { a { color: red } } @keyframes spin { to { rotate: 1turn } } @media (width >= 1px) { .fog-x { color: red } }",
    );
    expect(classSelectors(blocks).map((b) => b.prelude)).toEqual([".fog-x"]);
  });

  it("finds override paths and lets self-targeting variants through", () => {
    expect(overridePath("*:p-md")).not.toBeNull();
    expect(overridePath("**:text-sm")).not.toBeNull();
    expect(overridePath("[&_p]:mt-md")).not.toBeNull();
    expect(overridePath("[&>svg]:size-icon-md")).not.toBeNull();
    expect(overridePath("lg:[&_*]:p-md")).not.toBeNull();
    expect(overridePath("space-y-md")).not.toBeNull();
    expect(overridePath("divide-y")).not.toBeNull();
    expect(overridePath("hover:bg-bg-hover")).toBeNull();
    expect(overridePath("has-[>p]:p-md")).toBeNull();
    expect(overridePath("[&:has(>p)]:p-md")).toBeNull();
    expect(overridePath("[.dark_&]:p-md")).toBeNull();
    expect(overridePath("group-hover:text-primary")).toBeNull();
    expect(overridePath("backdrop:bg-overlay")).toBeNull();
    expect(overridePath("[@media(hover:hover)]:p-md")).toBeNull();
    expect(overridePath("p-(--pad-btn)")).toBeNull();
  });

  it("finds the combinator a named selector puts after `&`", () => {
    expect(selectorCombinators("&")).toEqual([]);
    expect(selectorCombinators("&:hover")).toEqual([]);
    expect(selectorCombinators("&:where(.dark, .dark *)")).toEqual([]);
    expect(selectorCombinators(".dark &")).toEqual([]);
    expect(selectorCombinators("& > *")).not.toEqual([]);
    expect(selectorCombinators("& p")).not.toEqual([]);
    expect(selectorCombinators("& + *")).not.toEqual([]);
  });

  it("allows a sibling only through next-sibling:mt-*", () => {
    expect(siblingMisuse("next-sibling:mt-md")).toBeNull();
    expect(siblingMisuse("lg:next-sibling:mt-sm")).toBeNull();
    expect(siblingMisuse("next-sibling:p-md")).not.toBeNull();
    expect(siblingMisuse("[&+*]:mt-md")).not.toBeNull();
    expect(siblingMisuse("[&~p]:mt-md")).not.toBeNull();
  });

  it("reads `(--token)` and bare `[var(--token)]` references", () => {
    expect(tokenReferences("p-(--space-md)")).toEqual(["--space-md"]);
    expect(tokenReferences("p-[var(--space-md)]")).toEqual(["--space-md"]);
    expect(tokenReferences("text-(length:--text-sm)")).toEqual(["--text-sm"]);
    expect(tokenReferences("text-[length:var(--text-sm)]")).toEqual([
      "--text-sm",
    ]);
    expect(tokenReferences("top-[calc(100%+var(--space-xs))]")).toEqual([]);
    expect(tokenReferences("p-md")).toEqual([]);
  });

  it("walks nested rules and keeps declarations out of strings and comments", () => {
    const { decls, blocks } = walkCss(
      '/* a: b; */ .x { content: "a;b{"; &:hover { color: red; } }\n@media (width >= 1px) { .y { margin: 0 } }',
    );
    expect(decls.map((d) => [d.prop, d.value, d.context])).toEqual([
      ["content", '"a;b{"', [".x"]],
      ["color", "red", [".x", "&:hover"]],
      ["margin", "0", ["@media (width >= 1px)", ".y"]],
    ]);
    expect(blocks.map((b) => b.prelude)).toEqual([
      ".x",
      "&:hover",
      "@media (width >= 1px)",
      ".y",
    ]);
  });

  it("walks past an escaped quote in a selector", () => {
    const walk = walkCss(
      String.raw`.content-\[\'a\'\] { color: var(--a) } @media (width >= 1px) { .y { color: var(--b) } }`,
    );
    expect(walk.decls.map((d) => [d.value, d.context])).toEqual([
      ["var(--a)", [String.raw`.content-\[\'a\'\]`]],
      ["var(--b)", ["@media (width >= 1px)", ".y"]],
    ]);
    expect(walk.unterminated).toBe(false);
  });

  it("reports a walk that ran off the end", () => {
    expect(walkCss(".x { color: var(--a) }").unterminated).toBe(false);
    expect(walkCss(".x { color: var(--a)").unterminated).toBe(true);
    expect(walkCss(`.x { content: "a }`).unterminated).toBe(true);
  });
});
