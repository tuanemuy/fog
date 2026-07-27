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
      continue;
    }
    if (typeof record.file !== "string" || !existsSync(record.file)) {
      fail(`${row.id} references missing file ${record.file}`);
      continue;
    }
    const source = readFileSync(record.file, "utf8");
    if (record.suite === "manual" || record.suite === "release-gate") {
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
  console.log(
    `test traceability audit passed (${rows.length} TEST IDs, executable evidence verified)`,
  );
}
