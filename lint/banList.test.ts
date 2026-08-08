import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps `no-instanceof-error.grit`'s hand-written ban list in sync with the
// error classes that actually exist. The plugin matches the identifier as
// written, so a class missing from the list is silently unprotected; this test
// turns that silence into a red build.
//
// It lives in `lint/` rather than in a workspace package because the ban list
// spans `apps/web` and `packages/core`: asserting it from inside `packages/core`
// would make the innermost package enumerate class names owned by the app.
//
// What this scan can and cannot see is pinned by the `declaredErrorClasses`
// cases below and restated in `no-instanceof-error.grit`'s KNOWN LIMITS.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRIT_FILE = join(REPO_ROOT, "lint", "no-instanceof-error.grit");

// Scanned roots mirror `biome.json`'s `linter.includes` roots — the tree the
// plugin is pointed at, `lint/` included; the mirror is asserted below, so a
// root added to `linter.includes` without a matching entry here turns red
// instead of leaving its classes off the ban list. The paths `linter.includes` subtracts
// from those roots (`components/ui/**`, `styles/**`, `templates/**`) are
// deliberately NOT skipped here: a class declared there is still importable and
// still `instanceof`-able from a linted file, so it still belongs on the ban list.
const SCAN_ROOTS = ["apps", "packages", "infra", "lint"];

// Directory names that hold no first-party source: dependencies, build output
// and local runtime state.
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".output",
  ".nitro",
  ".tanstack",
  ".wrangler",
  ".direnv",
  ".git",
]);

// Takes a repository-relative or absolute path, never a bare basename: the
// `__tests__` clause reads path segments and silently never fires on a basename.
//
// A `.d.ts` declares classes it does not own (`worker-configuration.d.ts` alone
// contributes `CompileError`, `RuntimeError`, `NonRetryableError` from the
// Workers runtime), and a test's fixtures (`TestCodedError`, `LayerlessCodedError`,
// …) are test-local props, not repository errors — including the ones that live
// beside a test in `__tests__/fakes/`, where the `.test.ts` clause cannot reach
// them.
const isScannedSource = (path: string): boolean => {
  if (path.endsWith(".d.ts")) return false;
  // `pluginWiring.test.ts` writes a fixture under `packages/core/src/` and
  // deletes it again; vitest may be running this scan in a parallel worker while
  // it exists. Matching on the suffix keeps this independent of where it lands.
  if (path.endsWith(".tmp.ts")) return false;
  if (/\.(test|spec)\.tsx?$/.test(path)) return false;
  if (path.split(sep).includes("__tests__")) return false;
  return path.endsWith(".ts") || path.endsWith(".tsx");
};

const walk = (dir: string, out: string[]): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(path, out);
    } else if (entry.isFile() && isScannedSource(path)) {
      out.push(path);
    }
  }
  return out;
};

// Every `class` declaration, `export`ed or not. `export default class` and a bare
// `class X {}` picked up by a later `export { X }` are both reachable for a
// cross-module `instanceof`, and neither is distinguishable from a truly
// module-private class without resolving the module graph. Over-detecting is the
// safe side: a module-private name on the ban list costs one line and bans an
// identifier no call site can hold anyway. (Measured on this repository: dropping
// the `export` requirement adds zero names.)
const CLASS_DECL =
  /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z0-9_$]+)/gm;

// A named class expression (`const X = class extends CodedError {}`) binds the
// same kind of stable identifier a declaration does, so a call site can hold it
// for a cross-module `instanceof` just as well. The captured name is the
// variable's — that is the identifier call sites import — and the header keeps
// any inner name plus the `extends` clause for the base-name half below.
const CLASS_EXPR =
  /^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z0-9_$]+)[^=\n]*=\s*class\b/gm;

// The rest of the header — everything between the regex match and the class
// body's opening `{` — read with an angle-bracket depth counter rather than a
// lazy regex: a `{` inside a type-parameter constraint
// (`class X<T extends { a: string }> extends CodedError`) would otherwise
// truncate the header before the heritage clause, and an `extends Error`
// constraint (`class Retry<TError extends Error>`) would qualify a non-error
// class. Everything inside `<...>` is dropped, so the returned header holds
// only the heritage clause. A `>` preceded by `=` is an arrow
// (`<T extends () => void>`), not a closer. Returns null when no depth-0 `{`
// follows — then there is no class body and nothing to ban.
const headerAfter = (source: string, from: number): string | null => {
  let depth = 0;
  let header = "";
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "<") {
      depth += 1;
    } else if (ch === ">" && source[i - 1] !== "=") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (ch === "{") return header;
      header += ch;
    }
  }
  return null;
};

// Either half is enough to qualify: a `*Error` name, or a base class whose name
// ends in `Error` (so `class Foo extends CodedError` cannot dodge the check by
// being named something else).
const declaredErrorClasses = (source: string): string[] => {
  const found: string[] = [];
  for (const pattern of [CLASS_DECL, CLASS_EXPR]) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      const header = headerAfter(source, match.index + match[0].length);
      if (header === null) continue;
      if (
        name.endsWith("Error") ||
        /extends\s+[A-Za-z0-9_$.]*Error\b/.test(header)
      ) {
        found.push(name);
      }
    }
  }
  return found;
};

const parseBanList = (grit: string): string[] => {
  const block = /\$type\s*<:\s*or\s*\{([^}]*)\}/.exec(grit);
  if (block === null) {
    throw new Error(
      "Could not locate the `$type <: or { ... }` ban list in no-instanceof-error.grit",
    );
  }
  return [...block[1].matchAll(/`([A-Za-z0-9_$]+)`/g)].map(([, name]) => name);
};

const scannedFiles = SCAN_ROOTS.flatMap((root) =>
  walk(join(REPO_ROOT, root), []),
);

describe("no-instanceof-error.grit ban list", () => {
  const banList = parseBanList(readFileSync(GRIT_FILE, "utf8"));

  const declared = new Map<string, string>();
  for (const file of scannedFiles) {
    for (const name of declaredErrorClasses(readFileSync(file, "utf8"))) {
      declared.set(name, file.slice(REPO_ROOT.length + 1));
    }
  }

  // Guards against the checks below passing vacuously if the `.grit` grammar or
  // the source layout changes under them.
  it("parses a non-empty ban list and finds error classes in both workspaces", () => {
    expect(banList.length).toBeGreaterThan(0);
    expect(new Set(banList).size).toBe(banList.length);
    expect(
      [...declared.values()].some((p) => p.startsWith(join("apps", "web"))),
    ).toBe(true);
    expect(
      [...declared.values()].some((p) =>
        p.startsWith(join("packages", "core")),
      ),
    ).toBe(true);
  });

  it("bans every exported error class in the repository", () => {
    const missing = [...declared]
      .filter(([name]) => !banList.includes(name))
      .map(([name, path]) => `${name} (${path})`);
    expect(
      missing,
      "Add these to the `$type <: or { ... }` list in lint/no-instanceof-error.grit",
    ).toEqual([]);
  });

  // The forward half of the mirror the SCAN_ROOTS comment claims. A root added
  // to `linter.includes` but not walked here is the silent direction: classes
  // declared under it would be lintable yet never reach the ban list. Roots the
  // scan walks beyond `linter.includes` are fine — extra coverage, not drift.
  it("walks every directory root biome.json's linter.includes points the plugin at", () => {
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, "biome.json"), "utf8"),
    ) as { linter: { includes: string[] } };
    const positiveGlobs = config.linter.includes.filter(
      (glob) => !glob.startsWith("!"),
    );
    // The root derivation below only works on `root/**`-shaped globs. A glob
    // whose first segment is a wildcard (`**/tools/**`) names no single root and
    // would be dropped silently, reopening the gap this mirror closes — so an
    // unexpected shape is a failure, not a skip.
    expect(
      positiveGlobs.filter((glob) => glob.split("/")[0].includes("*")),
      "linter.includes has a positive glob whose first segment is a wildcard; this mirror can only derive roots from `root/**`-shaped globs — restructure the glob or extend the derivation here (and in lint/pluginWiring.test.ts)",
    ).toEqual([]);
    const includeRoots = positiveGlobs.map((glob) => glob.split("/")[0]);
    expect(includeRoots.length).toBeGreaterThan(0);
    expect(
      includeRoots.filter((root) => !SCAN_ROOTS.includes(root)),
      "linter.includes points the plugin at roots this scan does not walk; add them to SCAN_ROOTS (and a fixture root in lint/pluginWiring.test.ts)",
    ).toEqual([]);
  });

  it("has no ban-list entry without a declaring class", () => {
    const stale = banList.filter((name) => !declared.has(name));
    expect(
      stale,
      "These names no longer exist in the repository; drop them from lint/no-instanceof-error.grit",
    ).toEqual([]);
  });
});

// The scan's own reach. Without these the two halves of `declaredErrorClasses`
// and the exclusions in `isScannedSource` are only exercised by whatever the
// repository happens to contain today — which is why they were dead code and
// deletable while staying green.
describe("no-instanceof-error.grit ban list — what the scan reaches", () => {
  it("qualifies a class by its base name even when its own name does not end in Error", () => {
    expect(
      declaredErrorClasses("export class NotNamedLikeOne extends CodedError {"),
    ).toEqual(["NotNamedLikeOne"]);
  });

  it("finds a class in every declaration form that a cross-module instanceof can reach", () => {
    expect(
      declaredErrorClasses(
        "export abstract class AbstractError extends Error {",
      ),
    ).toEqual(["AbstractError"]);
    expect(
      declaredErrorClasses(
        "export default class DefaultError extends Error {}",
      ),
    ).toEqual(["DefaultError"]);
    expect(
      declaredErrorClasses(
        "class DeferredError extends Error {}\nexport { DeferredError };",
      ),
    ).toEqual(["DeferredError"]);
  });

  it("finds a named class expression by its binding, qualified by either half", () => {
    expect(
      declaredErrorClasses(
        "export const ExprError = class extends SomethingElse {};",
      ),
    ).toEqual(["ExprError"]);
    expect(
      declaredErrorClasses("const Hidden = class extends CodedError {};"),
    ).toEqual(["Hidden"]);
  });

  it("reads past a type-parameter list to the heritage clause behind it", () => {
    expect(
      declaredErrorClasses(
        "export class Weird<T extends { a: string }> extends CodedError {",
      ),
    ).toEqual(["Weird"]);
    expect(
      declaredErrorClasses(
        "export class Arrow<T extends () => void> extends CodedError {",
      ),
    ).toEqual(["Arrow"]);
  });

  it("does not qualify a class by an extends constraint inside its type parameters", () => {
    expect(
      declaredErrorClasses("export class Retry<TError extends Error> {"),
    ).toEqual([]);
  });

  // KNOWN LIMITS, restated in no-instanceof-error.grit's header. Both are
  // unreachable for the plugin too — it matches the identifier as written, and
  // neither form gives a call site a stable identifier to name.
  it("misses a class whose name and visible base both hide that it is an error", () => {
    expect(
      declaredErrorClasses(
        "import { CodedError as Base } from './e';\nexport class Weird extends Base {",
      ),
    ).toEqual([]);
    expect(
      declaredErrorClasses("export default class extends Error {}"),
    ).toEqual([]);
  });

  it("skips sources whose classes are not repository errors", () => {
    const p = (...parts: string[]) => join(REPO_ROOT, ...parts);
    expect(isScannedSource(p("apps", "web", "worker-configuration.d.ts"))).toBe(
      false,
    );
    expect(
      isScannedSource(
        p("packages", "core", "src", "lib", "__tests__", "error.test.ts"),
      ),
    ).toBe(false);
    // The `__tests__` clause, not the `.test.ts` one: a fixture beside a test.
    expect(
      isScannedSource(
        p(
          "packages",
          "core",
          "src",
          "application",
          "__tests__",
          "fakes",
          "fakeError.ts",
        ),
      ),
    ).toBe(false);
    expect(
      isScannedSource(p("packages", "core", "src", "pluginWiring.4242.tmp.ts")),
    ).toBe(false);
    expect(
      isScannedSource(p("packages", "core", "src", "lib", "error.ts")),
    ).toBe(true);
  });

  // …and that `walk` actually reaches `isScannedSource` with something it can
  // decide on. The `__tests__` clause reads path segments, so handing it a
  // basename — as the original `walk` did — makes it silently never fire. This
  // is non-vacuous because `packages/core/src/application/__tests__/fakes/`
  // holds `.ts` fixtures that only that clause can exclude.
  it("keeps those sources out of the set it actually scans", () => {
    expect(scannedFiles.length).toBeGreaterThan(0);
    expect(
      scannedFiles.filter((f) => f.split(sep).includes("__tests__")),
    ).toEqual([]);
    expect(scannedFiles.filter((f) => f.endsWith(".d.ts"))).toEqual([]);
    expect(scannedFiles.filter((f) => /\.(test|spec)\.tsx?$/.test(f))).toEqual(
      [],
    );
  });
});
