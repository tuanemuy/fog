import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function receipt(
  kind: "user-data" | "identity-directory",
  restoreBookmark: string,
  undoBookmark: string,
) {
  return {
    version: 2,
    target:
      kind === "user-data"
        ? { kind, accountId: "opaque-account", objectName: "canonical-user" }
        : { kind, generation: "staging-v1", bucket: 3 },
    restoreBookmark,
    undoBookmark,
    proof: {
      id: `${kind}-proof`,
      previousSessionId: `${kind}-session`,
      undoBookmark,
    },
  };
}

describe("staging PITR workflow evidence writer", () => {
  it("creates one commit-bound passed result for each restored class", () => {
    const directory = mkdtempSync(`${tmpdir()}/fog-pitr-evidence-`);
    const artifactDirectory = resolve(directory, ".artifacts/pitr");
    mkdirSync(artifactDirectory, { recursive: true });
    for (const kind of ["user-data", "identity-directory"] as const) {
      writeFileSync(
        resolve(artifactDirectory, `${kind}-restore.json`),
        JSON.stringify(receipt(kind, "old", "before")),
      );
      writeFileSync(
        resolve(artifactDirectory, `${kind}-undo.json`),
        JSON.stringify(receipt(kind, "before", "after")),
      );
    }

    try {
      execFileSync(
        process.execPath,
        [resolve("scripts/write-pitr-evidence.mjs")],
        {
          cwd: directory,
          env: {
            ...process.env,
            GITHUB_REPOSITORY: "tuanemuy/fog",
            GITHUB_RUN_ID: "123456",
            GITHUB_SHA: "a".repeat(40),
            PITR_NAMESPACE: "disposable-staging",
            PITR_USER_DATA_TARGET: "opaque-account",
            PITR_DIRECTORY_TARGET: "staging-v1:3",
          },
        },
      );
      const evidence = JSON.parse(
        readFileSync(resolve(artifactDirectory, "staging.json"), "utf8"),
      );
      expect(evidence).toMatchObject({
        result: "passed",
        commitSha: "a".repeat(40),
        runUrl: "https://github.com/tuanemuy/fog/actions/runs/123456",
        classes: [
          { kind: "user-data", result: "passed" },
          { kind: "identity-directory", result: "passed" },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
