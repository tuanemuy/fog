import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { workingTreeFingerprint } from "./evidence-working-tree.mjs";

const [suite, ...reportPaths] = process.argv.slice(2);
if (!suite || reportPaths.length === 0) {
  throw new Error(
    "usage: stamp-vitest-evidence.mjs <suite> <report.json> [...]",
  );
}

const repositoryRoot = process.cwd();
const commitSha =
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
const runUrl =
  process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
const tests = [];

for (const reportPath of reportPaths) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.success !== true) {
    throw new Error(`${reportPath} does not contain a successful Vitest run`);
  }
  for (const file of report.testResults ?? []) {
    const filePath = relative(repositoryRoot, resolve(file.name));
    for (const result of file.assertionResults ?? []) {
      tests.push({
        file: filePath,
        test: result.title,
        fullName: result.fullName,
        status: result.status,
      });
    }
  }
}

const outputDirectory = resolve(repositoryRoot, ".artifacts/test-results");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, `${suite}.evidence.json`),
  `${JSON.stringify(
    {
      kind: "vitest",
      suite,
      commitSha,
      workingTreeFingerprint: workingTreeFingerprint(repositoryRoot),
      runUrl,
      tests,
    },
    null,
    2,
  )}\n`,
);
