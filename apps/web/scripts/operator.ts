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
 * requeue-poisoned-job, delete-poisoned-job, purge-user-mappings,
 * start-rotate-encryption, remap-chunk, import-remapped-mappings,
 * record-remapped-locator, read-rotation-checkpoint.
 *
 * `--inject-keyring` reads `DIRECTORY_ROUTING_KEYRING` (or
 * `DIRECTORY_ROUTING_SECRET` as generation 1) from `.dev.vars` and adds
 * the `active` / `previous` entries to the body, so a key is never typed
 * on a command line. `--limit N` and `--after <credentialId>` fill
 * `remap-chunk`'s cursor arguments.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function devVars(): Map<string, string> {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".dev.vars",
  );
  const vars = new Map<string, string>();
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = (match[2] ?? "").trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    vars.set(match[1] ?? "", unquoted);
  }
  return vars;
}

type KeyEntry = {
  role: "active" | "previous";
  generation: number;
  key: string;
  bucketCount: number;
};

function keyringFrom(vars: Map<string, string>): KeyEntry[] {
  const json =
    process.env.DIRECTORY_ROUTING_KEYRING ??
    vars.get("DIRECTORY_ROUTING_KEYRING");
  if (json !== undefined && json.length > 0)
    return JSON.parse(json) as KeyEntry[];
  const single =
    process.env.DIRECTORY_ROUTING_SECRET ??
    vars.get("DIRECTORY_ROUTING_SECRET");
  if (single === undefined || single.length === 0) {
    throw new Error(
      "neither DIRECTORY_ROUTING_KEYRING nor DIRECTORY_ROUTING_SECRET is set",
    );
  }
  return [{ role: "active", generation: 1, key: single, bucketCount: 16 }];
}

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  console.error(
    "usage: operator <entry> --locator <dir:gN:bM | userId> [--json '{…}'] [--inject-keyring] [--limit N] [--after id] [--base url]",
  );
  process.exit(1);
}
const locator = option(rest, "--locator");
if (!locator) {
  console.error("--locator is required");
  process.exit(1);
}
const vars = devVars();
const base = option(rest, "--base") ?? "http://localhost:3000";
const token = process.env.OPERATOR_TOKEN ?? vars.get("OPERATOR_TOKEN");
if (!token) {
  console.error(
    "OPERATOR_TOKEN is not set (environment or apps/web/.dev.vars)",
  );
  process.exit(1);
}
const extra = option(rest, "--json");
const body: Record<string, unknown> = {
  locator,
  ...(extra ? (JSON.parse(extra) as Record<string, unknown>) : {}),
};
if (flag(rest, "--inject-keyring")) {
  const entries = keyringFrom(vars);
  const active = entries.find((e) => e.role === "active");
  const previous = entries.find((e) => e.role === "previous");
  if (active) body.active = active;
  if (previous) body.previous = previous;
}
const limit = option(rest, "--limit");
if (limit !== undefined) body.limit = Number(limit);
const after = option(rest, "--after");
if (after !== undefined) body.afterCredentialId = after;

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
