import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function workingTreeFingerprint(repositoryRoot) {
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ".",
      ":(exclude).thread/19/test-results.json",
    ],
    { cwd: repositoryRoot },
  );
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  if (diff.length === 0 && untracked.length === 0) return "clean";

  const digest = createHash("sha256").update(diff);
  for (const file of untracked) {
    digest.update(`\0${file}\0`);
    digest.update(readFileSync(`${repositoryRoot}/${file}`));
  }
  return digest.digest("hex");
}
