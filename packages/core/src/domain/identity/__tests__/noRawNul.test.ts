import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The SSO canonical's separator is `U+0000`, and it must appear in a source
 * file as a JavaScript escape rather than as the byte itself.
 *
 * A raw NUL makes `grep` classify the file as binary, at which point it reports
 * **zero matches without saying so** — breaking the mechanical checks and the
 * hand-off searches in the same stroke, and doing it silently.
 *
 * Scoped to the whole TypeScript tree rather than to `valueObject.ts` alone: a
 * single-file guard is what let a raw NUL reach the shared forbidden-value
 * fixture, where it silently disabled `grep` over the one module whose job is
 * to catch leaks.
 */

const ROOTS = ["packages/core/src", "apps/web/app"];

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

function typescriptFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...typescriptFilesIn(path));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

describe("the TypeScript sources", () => {
  const files = ROOTS.flatMap((root) =>
    typescriptFilesIn(join(REPO_ROOT, root)),
  );

  it("cover both roots, so the scan is not vacuous", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("contain no raw NUL byte", () => {
    const offenders = files.filter((file) =>
      readFileSync(file, "utf8").includes(String.fromCharCode(0)),
    );
    expect(offenders.map((file) => file.slice(REPO_ROOT.length))).toEqual([]);
  });

  it("write the SSO separator as an escape", () => {
    const source = readFileSync(
      join(REPO_ROOT, "packages/core/src/domain/identity/valueObject.ts"),
      "utf8",
    );
    expect(source).toContain("u0000");
  });
});
