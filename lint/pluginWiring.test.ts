import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `banList.test.ts` checks that the ban list names the right classes. It cannot
// tell whether the plugin holding that list is wired up at all: with
// `biome.json`'s `plugins` line deleted, or with `register_diagnostic(...)`
// dropped from the query, every check in that file still passes and `pnpm lint`
// still exits 0. This test closes exactly that gap and nothing more — that the
// mechanism this PR introduced produces a diagnostic end to end.
//
// Deliberately out of scope, one layer further in: that Biome runs, that GritQL
// parses, that each ban-list entry fires individually. The first two are
// upstream's contract; the last is the drift `banList.test.ts` already owns.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The package's `bin/` entry rather than `node_modules/.bin/biome`, which is a
// shell shim on POSIX and a separate `.cmd` on Windows.
const BIOME = createRequire(import.meta.url).resolve(
  "@biomejs/biome/bin/biome",
);

// The fixture must sit inside `biome.json`'s `linter.includes` or no rule runs
// over it at all — a repo-root `*.ts` and `**/components/ui/**` both yield zero
// diagnostics. `.tmp.ts` is `.gitignore`d so an abandoned fixture cannot reach a
// commit, and `banList.test.ts` skips that suffix so a parallel worker cannot
// read it mid-delete.
const FIXTURE = join(REPO_ROOT, "lint", "pluginWiring.tmp.ts");

// `ConflictError` is on the ban list. `declare` keeps the fixture free of a class
// declaration, which `banList.test.ts`'s scan would otherwise have to reason about.
const FIXTURE_SOURCE = `declare const ConflictError: new () => Error;
export const isConflict = (e: unknown): boolean => e instanceof ConflictError;
`;

type Diagnostic = { category?: string; message?: string };

// `--stdin-file-path` reports nothing but "The contents aren't fixed", so the
// fixture has to be a real file on disk. `--vcs-use-ignore-file=false` is what
// keeps Biome from skipping it over the `.gitignore` entry above. A diagnostic
// makes Biome exit 1, so the status is not the assertion — the report is.
const lintFixture = (): Diagnostic[] => {
  const { stdout, error } = spawnSync(
    process.execPath,
    [BIOME, "lint", "--reporter=json", "--vcs-use-ignore-file=false", FIXTURE],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (error !== undefined) throw error;
  return (JSON.parse(stdout) as { diagnostics: Diagnostic[] }).diagnostics;
};

describe("no-instanceof-error.grit wiring", () => {
  it("reports a plugin diagnostic for an instanceof against a banned class", () => {
    writeFileSync(FIXTURE, FIXTURE_SOURCE);
    try {
      expect(
        lintFixture().filter((d) => d.category === "plugin"),
        "Biome reported no plugin diagnostic. Check that `biome.json`'s `plugins` still lists lint/no-instanceof-error.grit and that the query still calls register_diagnostic().",
      ).not.toEqual([]);
    } finally {
      rmSync(FIXTURE, { force: true });
    }
  });
});
