import type { WorkerRole } from "./deployStage";

/**
 * One row of the ownership table in `.dev.vars.example`.
 *
 * - `secret`: installed on `owner` in every deployed stage; `rotationOnly`
 *   ones exist only for the duration of a key rotation.
 * - `localOnly`: read from `.dev.vars` alone and installed nowhere.
 * - `var`: a `[vars]` entry of a wrangler config, never a secret.
 */
export type RosterEntry =
  | Readonly<{
      kind: "secret";
      name: string;
      owner: WorkerRole;
      rotationOnly: boolean;
    }>
  | Readonly<{ kind: "localOnly"; name: string }>
  | Readonly<{ kind: "var"; name: string }>;

export type SecretRoster = Readonly<{
  entries: readonly RosterEntry[];
  /** The value `.dev.vars.example` assigns to each name, unquoted. */
  developmentValues: Readonly<Record<string, string>>;
}>;

const TABLE_HEADING = "# === Which Worker owns which secret ===";
const ROW = /^# {3}([A-Z][A-Z0-9_]*)\s+— (.+)$/;
const CONTINUATION = /^# {4,}\S/;
const SECRET_OWNER =
  /^(request|state) Worker(, \*\*(local|rotation) only\*\*)?(?: \(|$)/;
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;

function entryOf(name: string, description: string): RosterEntry {
  if (description.startsWith("not a secret:")) return { kind: "var", name };
  const match = SECRET_OWNER.exec(description);
  if (match === null) {
    throw new Error(
      `.dev.vars.example: the row for ${name} names no owner this parser knows: "${description}"`,
    );
  }
  if (match[3] === "local") return { kind: "localOnly", name };
  return {
    kind: "secret",
    name,
    owner: match[1] as WorkerRole,
    rotationOnly: match[3] === "rotation",
  };
}

function unquote(raw: string): string {
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  return quoted?.[1] ?? raw;
}

/**
 * Read the ownership table and the assignments out of `.dev.vars.example`.
 *
 * The table is the rows between the heading and the next bare `#`. A row
 * is `#   NAME — <owner>`, and an indented comment line continues the row
 * above it. Anything else in that span throws, so a row written in a new
 * shape stops the deploy's secret check instead of silently dropping out
 * of the roster.
 */
export function parseSecretRoster(example: string): SecretRoster {
  const lines = example.split("\n");
  const heading = lines.findIndex((line) => line.startsWith(TABLE_HEADING));
  if (heading === -1) {
    throw new Error(".dev.vars.example: the ownership table is missing");
  }
  const first = lines.findIndex(
    (line, index) => index > heading && ROW.test(line),
  );
  if (first === -1) {
    throw new Error(".dev.vars.example: the ownership table has no rows");
  }

  const entries: RosterEntry[] = [];
  for (const line of lines.slice(first)) {
    if (line === "#") break;
    const row = ROW.exec(line);
    if (row !== null) {
      entries.push(entryOf(row[1] ?? "", row[2] ?? ""));
    } else if (!CONTINUATION.test(line)) {
      throw new Error(
        `.dev.vars.example: unreadable line in the ownership table: "${line}"`,
      );
    }
  }

  const developmentValues = Object.fromEntries(
    lines.flatMap((line) => {
      const assignment = ASSIGNMENT.exec(line);
      return assignment === null
        ? []
        : [[assignment[1] ?? "", unquote(assignment[2] ?? "")]];
    }),
  );

  return { entries, developmentValues };
}
