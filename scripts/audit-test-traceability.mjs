import { existsSync, readFileSync } from "node:fs";

const inventory = readFileSync("spec/inventory/test.md", "utf8");
const evidencePath = "spec/inventory/test-evidence.json";
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const rootScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const webScripts = JSON.parse(
  readFileSync("apps/web/package.json", "utf8"),
).scripts;
const requestConfig = readFileSync("vitest.config.integration.ts", "utf8");
const stateConfig = readFileSync(
  "vitest.config.integration-state.ts",
  "utf8",
);
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const results = JSON.parse(
  readFileSync(".thread/19/test-results.json", "utf8"),
);
const passedCommands = new Set(
  results.automated
    .filter((entry) => entry.result === "passed")
    .map((entry) => entry.command),
);
const releaseResults = new Map(
  results.releaseGates.map((entry) => [entry.name, entry]),
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
  "integration-state",
  "ci-command",
]);
const suiteCommand = new Map([
  ["unit", "pnpm test:unit"],
  ["integration-request", "pnpm test:integration"],
  ["integration-state", "pnpm test:integration"],
]);
const pending = [];

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
      if (!passedCommands.has(`pnpm ${record.command}`)) {
        fail(`${row.id} command ${record.command} has no current passing result`);
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
    if (typeof record.test !== "string" || !source.includes(record.test)) {
      fail(`${row.id} test name is absent from ${record.file}`);
    }
    const command = suiteCommand.get(record.suite);
    if (command !== undefined && !passedCommands.has(command)) {
      fail(`${row.id} suite ${record.suite} has no current passing result`);
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
        !requestConfig.includes("requestStateBoundary.integration.test.ts"))
    ) {
      fail(`${row.id} is not included by request integration config`);
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
    `test traceability structure passed (${rows.length} TEST IDs; source, CI inclusion, and recorded suite results checked; ${suffix})`,
  );
}
