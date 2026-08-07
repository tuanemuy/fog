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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRIT_FILE = join(REPO_ROOT, "lint", "no-instanceof-error.grit");

// Scanned roots mirror `biome.json`'s `linter.includes` roots — the tree the
// plugin is pointed at. The paths `linter.includes` subtracts from those roots
// (`components/ui/**`, `styles/**`, `templates/**`) are deliberately NOT skipped
// here: a class declared there is still importable and still `instanceof`-able
// from a linted file, so it still belongs on the ban list.
const SCAN_ROOTS = ["apps", "packages", "infra"];

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

// A `.d.ts` declares classes it does not own (`worker-configuration.d.ts` alone
// contributes `CompileError`, `RuntimeError`, `NonRetryableError` from the
// Workers runtime), and a test file's local fixtures (`TestCodedError`,
// `LayerlessCodedError`, …) are module-private props, not repository errors.
const isScannedSource = (path: string): boolean => {
  if (path.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.tsx?$/.test(path)) return false;
  if (path.split(sep).includes("__tests__")) return false;
  return path.endsWith(".ts") || path.endsWith(".tsx");
};

const walk = (dir: string, out: string[]): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && isScannedSource(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

// Only `export`ed declarations count: an unexported class cannot be named by
// another module, so no cross-module `instanceof` can reach it.
const CLASS_DECL =
  /^[ \t]*export[ \t]+(?:abstract[ \t]+)?class[ \t]+([A-Za-z0-9_$]+)([\s\S]*?)\{/gm;

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

describe("no-instanceof-error.grit ban list", () => {
  const banList = parseBanList(readFileSync(GRIT_FILE, "utf8"));

  const declared = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root), [])) {
      for (const name of declaredErrorClasses(readFileSync(file, "utf8"))) {
        declared.set(name, file.slice(REPO_ROOT.length + 1));
      }
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
