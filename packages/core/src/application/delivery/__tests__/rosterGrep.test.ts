import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY_DIRECTORY_JOB_KINDS, USER_DATA_JOB_KINDS } from "../types";

// The `event.type` half of the roster in `spec/async/index.md`, transcribed
// like the `jobs.kind` half in `jobKinds.test.ts`.
const ROSTER_EVENT_TYPES = ["identity.passwordResetRequested"] as const;

const JOB_KIND_ROSTER: ReadonlySet<string> = new Set([
  ...USER_DATA_JOB_KINDS,
  ...IDENTITY_DIRECTORY_JOB_KINDS,
]);

// Both trees the sources live in, relative to the repository root vitest
// runs from. Test files are left out: they write rows with literal kinds
// on purpose.
const ROOTS = ["packages/core/src", "apps/web/app"] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // `lint/pluginWiring.test.ts` writes and removes `*.tmp.ts` fixtures
    // under this tree while a parallel worker may be scanning it.
    if (entry.endsWith(".tmp.ts")) continue;
    const path = join(dir, entry);
    if (entry === "__tests__" || entry === "node_modules") continue;
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((m) => (m[1] ? [m[1]] : []));
}

// A `jobs.kind` literal appears in three syntactic positions: the `kind`
// of an `enqueueJob` input, a job-registry key, and a `JobKind` array or
// union in `types.ts` (excluded — that is the module under comparison).
// The argument object may hold a nested one before `kind:` (`payload: {}`),
// so the scan tolerates a single level of braces rather than stopping at the
// first `}`.
const ENQUEUE_JOB_KIND =
  /enqueueJob\(\{(?:[^{}]|\{[^{}]*\})*?kind:\s*"([^"]+)"/gs;
const REGISTRY_KEY = /"([a-z]+(?:-[a-z]+)+)":\s*create\w+Handler\(/g;
// An `event.type` literal has the shape `<domain>.<camelCaseName>`: the name
// after the dot must carry an interior capital, which is what keeps a
// lower-case dotted string such as a file name out of the match.
const EVENT_TYPE_LITERAL = /"([a-z]+\.[a-z]+[A-Z][A-Za-z]*)"/g;

describe("the roster patterns themselves", () => {
  it("reads a kind that sits after a nested payload object", () => {
    expect(
      matches(
        'ctx.enqueueJob({ operationKey: k, payload: {}, kind: "purge-trash", nextRunAt: at });',
        ENQUEUE_JOB_KIND,
      ),
    ).toEqual(["purge-trash"]);
  });

  it("does not read a lower-case dotted string as an event type", () => {
    expect(
      matches('see "index.md" and "spec/async/index.md"', EVENT_TYPE_LITERAL),
    ).toEqual([]);
    expect(
      matches('"identity.passwordResetRequested"', EVENT_TYPE_LITERAL),
    ).toEqual(["identity.passwordResetRequested"]);
  });
});

describe("roster grep: no jobs.kind / event.type outside spec/async/index.md", () => {
  const files = ROOTS.flatMap((root) => sourceFiles(resolve(root)));
  const typesModule = resolve(
    "packages/core/src/application/delivery/types.ts",
  );

  it("scans a non-trivial set of sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every jobs.kind literal is in the roster", () => {
    const found = new Map<string, string[]>();
    for (const file of files) {
      if (file === typesModule) continue;
      const source = readFileSync(file, "utf8");
      for (const kind of [
        ...matches(source, ENQUEUE_JOB_KIND),
        ...matches(source, REGISTRY_KEY),
      ]) {
        found.set(kind, [...(found.get(kind) ?? []), file]);
      }
    }
    // Not vacuous: the registration saga enqueues two kinds and the
    // Identity Directory registry names them.
    expect([...found.keys()]).toEqual(
      expect.arrayContaining(["resume-signup", "sweep-reservations"]),
    );
    const outside = [...found].filter(([kind]) => !JOB_KIND_ROSTER.has(kind));
    expect(outside).toEqual([]);
  });

  it("every event.type literal is in the roster", () => {
    const found = new Map<string, string[]>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const type of matches(source, EVENT_TYPE_LITERAL)) {
        found.set(type, [...(found.get(type) ?? []), file]);
      }
    }
    expect([...found.keys()]).toEqual(
      expect.arrayContaining([...ROSTER_EVENT_TYPES]),
    );
    const roster: ReadonlySet<string> = new Set(ROSTER_EVENT_TYPES);
    const outside = [...found].filter(([type]) => !roster.has(type));
    expect(outside).toEqual([]);
  });
});
