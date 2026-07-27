import { readFileSync } from "node:fs";

const inventory = readFileSync("spec/inventory/test.md", "utf8");
const rows = [...inventory.matchAll(
  /^\|\s*(TEST-[A-Z]+-\d{3})\s*\|([^|]+)\|([^|]+)\|([^|]+)\|$/gmu,
)].map((match) => ({
  id: match[1],
  target: match[2].trim(),
  status: match[3].trim(),
  evidence: match[4].trim(),
}));

const declaredIds = [...inventory.matchAll(/\bTEST-[A-Z]+-\d{3}\b/gu)].map(
  (match) => match[0],
);
const failures = [];
if (rows.length === 0) failures.push("test inventory contains no parsed rows");
for (const id of new Set(declaredIds)) {
  const count = declaredIds.filter((candidate) => candidate === id).length;
  if (count !== 1) failures.push(`${id} is declared ${count} times`);
  if (!rows.some((row) => row.id === id)) {
    failures.push(`${id} has no status/evidence row`);
  }
}
for (const row of rows) {
  if (row.target.length === 0) failures.push(`${row.id} has no target`);
  if (!/^(?:automated|manual|release gate)(?: \+ (?:manual|staging|release gate))?$/u.test(row.status)) {
    failures.push(`${row.id} has unsupported status: ${row.status}`);
  }
  if (row.evidence.length === 0 || /\b(?:todo|tbd|未定)\b/iu.test(row.evidence)) {
    failures.push(`${row.id} has no concrete evidence`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`test traceability audit passed (${rows.length} unique TEST IDs)`);
}
