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
// plugin is pointed at, `lint/` included. The paths `linter.includes` subtracts
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
  /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z0-9_$]+)([\s\S]*?)\{/gm;

// Either half is enough to qualify: a `*Error` name, or a base class whose name
// ends in `Error` (so `class Foo extends CodedError` cannot dodge the check by
// being named something else).
const declaredErrorClasses = (source: string): string[] => {
  const found: string[] = [];
  for (const [, name, header] of source.matchAll(CLASS_DECL)) {
    if (
      name.endsWith("Error") ||
      /extends\s+[A-Za-z0-9_$.]*Error\b/.test(header)
    ) {
      found.push(name);
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
