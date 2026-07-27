import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { workingTreeFingerprint } from "./evidence-working-tree.mjs";

const inventory = readFileSync("spec/inventory/test.md", "utf8");
const evidencePath = "spec/inventory/test-evidence.json";
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const rootScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const webScripts = JSON.parse(
  readFileSync("apps/web/package.json", "utf8"),
).scripts;
const requestConfig = readFileSync("vitest.config.integration.ts", "utf8");
const productionConfig = readFileSync(
  "vitest.config.production-entry.ts",
  "utf8",
);
const stateConfig = readFileSync(
  "vitest.config.integration-state.ts",
  "utf8",
);
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const results = JSON.parse(
  readFileSync(".thread/19/test-results.json", "utf8"),
);
const releaseResults = new Map(
  results.releaseGates.map((entry) => [entry.name, entry]),
);
const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceFingerprint = workingTreeFingerprint(process.cwd());
const expectedRunUrl =
  process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
const artifactDirectory = ".artifacts/test-results";
const artifacts = existsSync(artifactDirectory)
  ? readdirSync(artifactDirectory)
      .filter((file) => file.endsWith(".evidence.json"))
      .map((file) =>
        JSON.parse(readFileSync(`${artifactDirectory}/${file}`, "utf8")),
      )
  : [];
const vitestArtifacts = new Map(
  artifacts
    .filter((artifact) => artifact.kind === "vitest")
    .map((artifact) => [artifact.suite, artifact]),
);
const commandArtifacts = new Map(
  artifacts
    .filter((artifact) => artifact.kind === "command")
    .map((artifact) => [artifact.command, artifact]),
);

const rows = [
  ...inventory.matchAll(
    /^\|\s*(TEST-[A-Z]+-\d{3})\s*\|([^|]+)\|([^|]+)\|([^|]+)\|$/gmu,
  ),
].map((match) => ({
  id: match[1],
  target: match[2].trim(),
  status: match[3].trim(),
  evidence: match[4].trim(),
}));

const failures = [];
const fail = (message) => failures.push(message);
if (rows.length === 0) fail("test inventory contains no parsed rows");

for (const id of new Set(rows.map((row) => row.id))) {
  const count = rows.filter((row) => row.id === id).length;
  if (count !== 1) fail(`${id} is declared ${count} times`);
}
for (const id of Object.keys(evidence)) {
  if (!rows.some((row) => row.id === id)) fail(`${id} is orphaned evidence`);
}

const automatedSuites = new Set([
  "unit",
  "integration-request",
  "integration-production",
  "integration-state",
  "ci-command",
]);
const pending = [];

for (const suite of [
  "unit",
  "integration-request",
  "integration-production",
  "integration-state",
]) {
  if (!vitestArtifacts.has(suite)) {
    fail(`${suite} has no machine-readable Vitest reporter artifact`);
  }
}

for (const artifact of artifacts) {
  if (artifact.commitSha !== headSha) {
    fail(
      `${artifact.kind} evidence for ${artifact.suite ?? artifact.command} belongs to ${String(artifact.commitSha)}, not HEAD ${headSha}`,
    );
  }
  if (artifact.workingTreeFingerprint !== sourceFingerprint) {
    fail(
      `${artifact.kind} evidence for ${artifact.suite ?? artifact.command} belongs to another working-tree state`,
    );
  }
  if (process.env.CI === "true" && artifact.runUrl !== expectedRunUrl) {
    fail(
      `${artifact.kind} evidence for ${artifact.suite ?? artifact.command} is not bound to this Actions run`,
    );
  }
  if (process.env.CI === "true" && artifact.workingTreeFingerprint !== "clean") {
    fail(
      `${artifact.kind} evidence for ${artifact.suite ?? artifact.command} is not from a clean checkout`,
    );
  }
}

for (const row of rows) {
  if (row.target.length === 0) fail(`${row.id} has no target`);
  if (
    !/^(?:automated|manual|release gate)(?: \+ (?:manual|staging|release gate))?$/u.test(
      row.status,
    )
  ) {
    fail(`${row.id} has unsupported status: ${row.status}`);
  }
  if (row.evidence !== `\`${evidencePath}#${row.id}\``) {
    fail(`${row.id} must reference its machine-readable evidence record`);
  }
  const records = evidence[row.id];
  if (!Array.isArray(records) || records.length === 0) {
    fail(`${row.id} has no executable evidence`);
    continue;
  }
  if (
    row.status.startsWith("automated") &&
    !records.some((record) => automatedSuites.has(record.suite))
  ) {
    fail(`${row.id} is automated but has no automated suite evidence`);
  }
  if (
    row.status.includes("manual") &&
    !records.some((record) => record.suite === "manual")
  ) {
    fail(`${row.id} is manual but has no manual evidence`);
  }
  if (
    (row.status.includes("release gate") || row.status.includes("staging")) &&
    !records.some((record) => record.suite === "release-gate")
  ) {
    fail(`${row.id} is a release gate but has no release result record`);
  }

  for (const record of records) {
    if (record.suite === "ci-command") {
      if (!(record.command in rootScripts) && !(record.command in webScripts)) {
        fail(`${row.id} references missing command ${record.command}`);
      }
      if (!workflow.includes(`pnpm ${record.command}`)) {
        fail(`${row.id} command ${record.command} is absent from CI`);
      }
      const command = `pnpm ${record.command}`;
      const artifact = commandArtifacts.get(command);
      if (artifact?.result !== "passed") {
        fail(
          `${row.id} command ${record.command} has no current passing command artifact`,
        );
      }
      continue;
    }
    if (typeof record.file !== "string" || !existsSync(record.file)) {
      fail(`${row.id} references missing file ${record.file}`);
      continue;
    }
    const source = readFileSync(record.file, "utf8");
    if (record.suite === "manual") {
      if (!["passed", "pending"].includes(record.result)) {
        fail(`${row.id} manual evidence must declare passed or pending`);
      }
      if (record.result === "pending") pending.push(`${row.id} manual`);
      if (
        typeof record.marker !== "string" ||
        !source.includes(record.marker)
      ) {
        fail(`${row.id} marker is absent from ${record.file}`);
      }
      continue;
    }
    if (record.suite === "release-gate") {
      const result = releaseResults.get(record.gate);
      if (!result) {
        fail(`${row.id} references missing release result ${record.gate}`);
        continue;
      }
      if (result.result !== "passed") {
        pending.push(`${row.id} ${record.gate}: ${result.result}`);
      }
      if (
        typeof record.marker !== "string" ||
        !source.includes(record.marker)
      ) {
        fail(`${row.id} marker is absent from ${record.file}`);
      }
      continue;
    }
    if (typeof record.test !== "string" || record.test.length === 0) {
      fail(`${row.id} has no test title in ${record.file}`);
    }
    const reporter = vitestArtifacts.get(record.suite);
    if (
      !reporter?.tests?.some(
        (test) =>
          test.file === record.file &&
          test.test === record.test &&
          test.status === "passed",
      )
    ) {
      fail(
        `${row.id} test was not reported passed by ${record.suite}: ${record.test}`,
      );
    }
    if (
      record.suite === "unit" &&
      record.file.endsWith(".integration.test.ts")
    ) {
      fail(`${row.id} marks an integration test as unit`);
    }
    if (
      record.suite === "integration-request" &&
      (!record.file.endsWith(".integration.test.ts") ||
        !requestConfig.includes(record.file.split("/").at(-1)))
    ) {
      fail(`${row.id} is not included by request integration config`);
    }
    if (
      record.suite === "integration-production" &&
      (!record.file.endsWith(".integration.test.ts") ||
        !productionConfig.includes(record.file.split("/").at(-1)))
    ) {
      fail(`${row.id} is not included by production integration config`);
    }
    if (
      record.suite === "integration-state" &&
      (!record.file.endsWith(".integration.test.ts") ||
        !stateConfig.includes(
          record.file.includes("/testing/")
            ? "migrations.integration.test.ts"
            : "durable-objects/**/*.integration.test.ts",
        ))
    ) {
      fail(`${row.id} is not included by state integration config`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  const suffix =
    pending.length === 0
      ? "no pending manual/release evidence"
      : `pending evidence: ${pending.join("; ")}`;
  console.log(
    `test traceability passed (${rows.length} TEST IDs; HEAD-bound reporter and command evidence checked${expectedRunUrl ? ` for ${expectedRunUrl}` : ""}; ${suffix})`,
  );
}
