import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The entry points that compose the request and state Workers. They are the
 * only modules under `apps/web/app` that may name a concrete adapter; every
 * other module reaches one through the container or a dependency the entry
 * point hands it.
 */
const COMPOSITION_ROOTS = ["server.cloudflare.ts", "worker/cloudflare/"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sources(path);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("adapter imports under apps/web/app", () => {
  it("come only from the composition roots", () => {
    const offenders = sources(appDir)
      .map((path) => relative(appDir, path))
      .filter(
        (path) => !COMPOSITION_ROOTS.some((root) => path.startsWith(root)),
      )
      .filter((path) =>
        /from\s+["']@repo\/core\/adapters\//.test(
          readFileSync(join(appDir, path), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("scans the tree it guards", () => {
    const scanned = sources(appDir).map((path) => relative(appDir, path));
    expect(scanned).toContain("presentation/export/handler.ts");
    expect(scanned).toContain("presentation/ai/oauth.ts");
  });
});
