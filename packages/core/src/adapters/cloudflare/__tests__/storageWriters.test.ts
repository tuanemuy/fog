import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// CLAUDE.md "Unit of Work": the context's stores and registration points
// are the complete set of write paths a usecase has. That holds only while
// no code outside the adapters writes storage by statement, so the scan
// pins every `INSERT` / `UPDATE` / `DELETE` / `REPLACE` naming a table to
// `packages/core/src/adapters/`. Reads are outside it (two application
// procedures read the caller binding by `SELECT`), and so is a statement
// assembled from pieces the regular expression cannot see.
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const SCAN_ROOTS = ["packages/core/src", "apps/web/app"];
const ADAPTERS = "packages/core/src/adapters/";
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".wrangler", ".output"]);
const WRITE = new RegExp(
  [
    String.raw`\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+[a-z_]+\s*(?:\(|VALUES\b|SELECT\b)`,
    String.raw`\bREPLACE\s+INTO\s+[a-z_]+\b`,
    String.raw`\bDELETE\s+FROM\s+[a-z_]+\b`,
    String.raw`\bUPDATE\s+[a-z_]+\s+SET\b`,
  ].join("|"),
);

function isScannedSource(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.tsx?$/.test(path)) return false;
  if (path.split(sep).includes("__tests__")) return false;
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(path);
    } else if (isScannedSource(path)) {
      yield path;
    }
  }
}

function writers(): string[] {
  return SCAN_ROOTS.flatMap((root) =>
    [...walk(join(REPO_ROOT, root))]
      .filter((path) => WRITE.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO_ROOT, path).split(sep).join("/")),
  ).sort();
}

describe("storage writes by statement", () => {
  it("live only in the adapters", () => {
    expect(writers().filter((path) => !path.startsWith(ADAPTERS))).toEqual([]);
  });

  it("recognises the statements it guards", () => {
    const found = writers();
    expect(found).toContain(
      "packages/core/src/adapters/cloudflare/stores/credentialLocatorStore.ts",
    );
    expect(found).toContain(
      "packages/core/src/adapters/cloudflare/jobRunner.ts",
    );
  });
});
