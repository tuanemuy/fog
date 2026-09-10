import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TC-keyRotation-022: `rotation_checkpoints` is written through the unit of
// work's `rotationCheckpointStore` and nowhere else. The scan pins that a
// statement naming the table appears in exactly two source files — the store
// that owns it and the DDL that creates it — so a second writer turns the
// build red. Prose mentions (JSDoc on the contract) are not statements.
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../..",
);
const SCAN_ROOTS = ["packages/core/src", "apps/web/app"];
const ALLOWED = new Set([
  "packages/core/src/adapters/cloudflare/stores/rotationCheckpointStore.ts",
  "packages/core/src/adapters/cloudflare/schema/identityDirectoryPlan.ts",
]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".wrangler", ".output"]);
const STATEMENT =
  /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+rotation_checkpoints\b/;

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

describe("rotation_checkpoints has one writer", () => {
  it("names the table only in the store and the DDL", () => {
    const mentions = SCAN_ROOTS.flatMap((root) =>
      [...walk(join(REPO_ROOT, root))]
        .filter((path) => STATEMENT.test(readFileSync(path, "utf8")))
        .map((path) => relative(REPO_ROOT, path).split(sep).join("/")),
    ).sort();
    expect(mentions).toEqual([...ALLOWED].sort());
  });
});
