/**
 * A local client for the operator maintenance surface
 * (`POST /__operator/<entry>`, PH-09). Runs on Node 24 with type
 * stripping:
 *
 *   node scripts/operator.ts <entry> --locator dir:g1:b0 [--json '{"eventId":"…"}'] [--base http://localhost:3000]
 *
 * The bearer token is read from `OPERATOR_TOKEN` in the environment or
 * from `apps/web/.dev.vars`. Entries: read-schema-version,
 * list-bucket-user-ids, read-delivery-backlog, list-quarantined-events,
 * requeue-quarantined-event, delete-quarantined-event, list-poisoned-jobs,
 * requeue-poisoned-job, delete-poisoned-job, purge-user-mappings.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function tokenFromDevVars(): string | undefined {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".dev.vars",
  );
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^OPERATOR_TOKEN="?([^"]*)"?\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  console.error(
    "usage: operator <entry> --locator <dir:gN:bM | userId> [--json '{…}'] [--base url]",
  );
  process.exit(1);
}
const locator = option(rest, "--locator");
if (!locator) {
  console.error("--locator is required");
  process.exit(1);
}
const base = option(rest, "--base") ?? "http://localhost:3000";
const token = process.env.OPERATOR_TOKEN ?? tokenFromDevVars();
if (!token) {
  console.error(
    "OPERATOR_TOKEN is not set (environment or apps/web/.dev.vars)",
  );
  process.exit(1);
}
const extra = option(rest, "--json");
const body = {
  locator,
  ...(extra ? (JSON.parse(extra) as Record<string, unknown>) : {}),
};
const response = await fetch(new URL(`/__operator/${entry}`, base), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});
const text = await response.text();
let parsed: unknown = text;
try {
  parsed = JSON.parse(text);
} catch {
  // not JSON: print as is
}
console.log(JSON.stringify({ status: response.status, body: parsed }, null, 2));
if (!response.ok) process.exit(2);
