import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No module of the application layer imports `adapters/`, except the two
 * composition roots.
 *
 * This is AC-25 (ii) with its exclusion tightened. The plan's `grep` excludes
 * `di/` wholesale, on the grounds that a composition root is the one legitimate
 * place concrete adapters are assembled — and that grounds covers exactly two
 * files. `di/facades.ts` assembles nothing; it is a contract module, and it sat
 * inside the exclusion importing seven adapter-owned types that travelled on
 * `RequestContainer` into four usecases. The mechanical check passed while the
 * rule it stands for was broken, twice over (ADR-071).
 *
 * Narrowing the exclusion to *value* imports would not work: both roots
 * `import type` an adapter's `*FacadeDeps` and `DirectoryLocator` as part of
 * the same assembly. Naming the two files is what makes the check say what the
 * rule says.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const APPLICATION = join(REPO_ROOT, "packages/core/src/application");

/** The composition roots — the only modules that may name a concrete adapter. */
const COMPOSITION_ROOTS = ["di/serverCloudflare.ts", "di/stateCloudflare.ts"];

const ADAPTER_IMPORT =
  /from\s+"(?:@repo\/core\/adapters\/|\.{1,2}\/(?:\.\.\/)*adapters\/)/;

function typescriptFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...typescriptFilesIn(path));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("the application layer", () => {
  const files = typescriptFilesIn(APPLICATION).map((file) =>
    file.slice(APPLICATION.length + 1),
  );

  it("is scanned at all, so the check is not vacuous", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toEqual(expect.arrayContaining(COMPOSITION_ROOTS));
  });

  it("imports `adapters/` only from the composition roots", () => {
    const offenders = files.filter(
      (file) =>
        !COMPOSITION_ROOTS.includes(file) &&
        ADAPTER_IMPORT.test(readFileSync(join(APPLICATION, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
