import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The fixtures live in the trees the ban is meant to protect, not beside this
// test. The plugin only runs over `biome.json`'s `linter.includes`, so a wired
// plugin whose includes no longer name `packages/**`, `apps/**` or `infra/**`
// disarms that root silently while a fixture under `lint/**` keeps reporting;
// one fixture per root means dropping any single root turns this red, not just
// all three at once. `.tmp.ts` is `.gitignore`d so an abandoned fixture cannot
// reach a commit, and `banList.test.ts` skips that suffix so a parallel worker
// cannot read it mid-delete. The pid keeps two vitest runs in one worktree from
// deleting each other's fixture.
const FIXTURE_ROOTS: ReadonlyArray<readonly string[]> = [
  ["packages", "core", "src"],
  ["apps", "web", "app"],
  ["infra", "cloudflare", "pulumi"],
];

const fixturePath = (root: readonly string[]): string =>
  join(REPO_ROOT, ...root, `pluginWiring.${process.pid}.tmp.ts`);

// `ConflictError` is on the ban list. `declare` keeps the fixture free of a class
// declaration, which `banList.test.ts`'s scan would otherwise have to reason about.
const FIXTURE_SOURCE = `declare const ConflictError: new () => Error;
export const isConflict = (e: unknown): boolean => e instanceof ConflictError;
`;

// Every GritQL plugin reports under `category: "plugin"`, so that alone would go
// green off a second plugin's diagnostic once one is added. This fragment is the
// `register_diagnostic(...)` message in `no-instanceof-error.grit`; rewording it
// there means rewording it here.
const DIAGNOSTIC_MESSAGE = "instead of instanceof";

type Diagnostic = { category?: string; message?: string };

// `--stdin-file-path` reports nothing but "The contents aren't fixed", so the
// fixture has to be a real file on disk. `--vcs-use-ignore-file=false` is what
// keeps Biome from skipping it over the `.gitignore` entry above. A diagnostic
// makes Biome exit 1, so the status is not the assertion — the report is.
const lintFixture = (fixture: string): Diagnostic[] => {
  const { stdout, stderr, status, error } = spawnSync(
    process.execPath,
    [BIOME, "lint", "--reporter=json", "--vcs-use-ignore-file=false", fixture],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (error !== undefined) throw error;
  try {
    return (JSON.parse(stdout) as { diagnostics: Diagnostic[] }).diagnostics;
  } catch (cause) {
    // Biome writes configuration and GritQL parse failures to stderr and leaves
    // stdout empty, which would otherwise surface only as "Unexpected end of
    // JSON input".
    throw new Error(
      `Biome did not return a JSON report (exit ${status}).\nstderr:\n${stderr}\nstdout:\n${stdout}`,
      { cause },
    );
  }
};

const pluginDiagnostics = (fixture: string): Diagnostic[] =>
  lintFixture(fixture).filter(
    (d) =>
      d.category === "plugin" && (d.message ?? "").includes(DIAGNOSTIC_MESSAGE),
  );

describe("no-instanceof-error.grit wiring", () => {
  it.each(FIXTURE_ROOTS.map((root) => [join(...root), root] as const))(
    "reports a plugin diagnostic for an instanceof against a banned class under %s",
    (label, root) => {
      const fixture = fixturePath(root);
      writeFileSync(fixture, FIXTURE_SOURCE);
      try {
        expect(
          pluginDiagnostics(fixture),
          `Biome reported no no-instanceof-error diagnostic for a fixture under ${label}. Check that \`biome.json\` still lists lint/no-instanceof-error.grit under \`plugins\`, that its \`linter.includes\` still covers that root, and that the query still calls register_diagnostic().`,
        ).not.toEqual([]);
      } finally {
        rmSync(fixture, { force: true });
      }
    },
  );

  // The per-root pinning above only holds while FIXTURE_ROOTS actually covers
  // the trees `linter.includes` points the plugin at. This asserts that mirror,
  // so a root added to `linter.includes` without a fixture under it turns red
  // instead of going unverified. `lint/**` is the standing exemption: this test
  // lives there, and a fixture beside it would prove nothing about the trees
  // the ban protects (see the FIXTURE_ROOTS comment).
  it("keeps a fixture root under every tree linter.includes points the plugin at", () => {
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, "biome.json"), "utf8"),
    ) as { linter: { includes: string[] } };
    const fixtureRoots = new Set(FIXTURE_ROOTS.map((root) => root[0]));
    expect(
      config.linter.includes
        .filter((glob) => !glob.startsWith("!"))
        .map((glob) => glob.split("/")[0])
        .filter((root) => !root.includes("*") && root !== "lint")
        .filter((root) => !fixtureRoots.has(root)),
      "linter.includes points the plugin at roots with no wiring fixture; add an entry to FIXTURE_ROOTS",
    ).toEqual([]);
  });

  // KNOWN LIMITS in no-instanceof-error.grit: the snippet match does not see
  // through `ParenthesizedExpression`, and the pattern is deliberately not
  // doubled with a wrapped twin per entry. This pins the documented limit so a
  // future pattern change that closes it (or reopens it) shows up here.
  it("does not fire on a parenthesized right-hand side (documented limit)", () => {
    const fixture = fixturePath(FIXTURE_ROOTS[0]);
    writeFileSync(
      fixture,
      `declare const ConflictError: new () => Error;
export const isConflict = (e: unknown): boolean =>
  e instanceof (ConflictError);
`,
    );
    try {
      expect(
        pluginDiagnostics(fixture),
        "The plugin now fires on `e instanceof (ConflictError)`. Update the KNOWN LIMITS Evasion entry in lint/no-instanceof-error.grit and flip this case.",
      ).toEqual([]);
    } finally {
      rmSync(fixture, { force: true });
    }
  });
});
