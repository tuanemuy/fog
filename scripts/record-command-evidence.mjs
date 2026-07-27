import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { workingTreeFingerprint } from "./evidence-working-tree.mjs";

const command = process.argv[2];
if (!command) {
  throw new Error("usage: record-command-evidence.mjs <command>");
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
const fileName = command.replaceAll(/[^a-z0-9]+/giu, "-").replace(/-+$/u, "");
const outputDirectory = resolve(repositoryRoot, ".artifacts/test-results");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, `command-${fileName}.evidence.json`),
  `${JSON.stringify(
    {
      kind: "command",
      command,
      result: "passed",
      commitSha,
      workingTreeFingerprint: workingTreeFingerprint(repositoryRoot),
      runUrl,
    },
    null,
    2,
  )}\n`,
);
