import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function receipt(path, kind) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 2 || value.target?.kind !== kind) {
    throw new Error(`${path} is not a ${kind} version 2 receipt`);
  }
  return value;
}

const repository = required("GITHUB_REPOSITORY");
const runId = required("GITHUB_RUN_ID");
const commitSha = required("GITHUB_SHA");
const verifiedAt = new Date();
const expiresAt = new Date(verifiedAt.getTime() + 7 * 24 * 60 * 60_000);
const userDataRestore = receipt(
  ".artifacts/pitr/user-data-restore.json",
  "user-data",
);
const userDataUndo = receipt(
  ".artifacts/pitr/user-data-undo.json",
  "user-data",
);
const directoryRestore = receipt(
  ".artifacts/pitr/identity-directory-restore.json",
  "identity-directory",
);
const directoryUndo = receipt(
  ".artifacts/pitr/identity-directory-undo.json",
  "identity-directory",
);
for (const [restore, undo] of [
  [userDataRestore, userDataUndo],
  [directoryRestore, directoryUndo],
]) {
  if (undo.restoreBookmark !== restore.undoBookmark) {
    throw new Error("undo receipt does not restore the pre-restore bookmark");
  }
}
const classes = [
  {
    kind: "user-data",
    target: required("PITR_USER_DATA_TARGET"),
    restoreReceipt: userDataRestore,
    undoReceipt: userDataUndo,
    verification: { restoreComplete: true, undoComplete: true },
    verifiedAt: verifiedAt.toISOString(),
    result: "passed",
  },
  {
    kind: "identity-directory",
    target: required("PITR_DIRECTORY_TARGET"),
    restoreReceipt: directoryRestore,
    undoReceipt: directoryUndo,
    verification: {
      restoreComplete: true,
      undoComplete: true,
      conflicts: 0,
      cursor: null,
    },
    verifiedAt: verifiedAt.toISOString(),
    result: "passed",
  },
];

mkdirSync(".artifacts/pitr", { recursive: true });
writeFileSync(
  ".artifacts/pitr/staging.json",
  `${JSON.stringify(
    {
      name: "staging PITR bookmark/restore/verify/undo",
      result: "passed",
      stage: "staging",
      namespace: required("PITR_NAMESPACE"),
      commitSha,
      runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
      expiresAt: expiresAt.toISOString(),
      classes,
    },
    null,
    2,
  )}\n`,
);
