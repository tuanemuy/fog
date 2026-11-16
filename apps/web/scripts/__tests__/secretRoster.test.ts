import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkerRole } from "../lib/deployStage";
import { parseSecretRoster } from "../lib/secretRoster";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(webRoot, "../..");
const example = readFileSync(resolve(webRoot, ".dev.vars.example"), "utf8");

const table = (...rows: string[]) =>
  [
    "# header",
    "# === Which Worker owns which secret ===========",
    "#",
    "# Prose above the table.",
    "#",
    ...rows,
    "#",
    "# Prose below the table.",
    "",
  ].join("\n");

describe("parseSecretRoster", () => {
  it("reads each kind of row", () => {
    const roster = parseSecretRoster(
      table(
        "#   A_KEY                — request Worker",
        "#   B_KEY                — state Worker (never leaves the Durable Object)",
        "#   C_KEY                — request Worker, **rotation only** (JSON)",
        "#   D_KEY                — state Worker, **rotation only** (digests)",
        "#   E_FLAG               — request Worker, **local only** (development sink)",
        "#   F_VAR                — not a secret: a [vars] entry of the request Worker",
        "#                          continued on an indented line",
        "#   G_VAR                — not a secret: a [vars] entry of the state Worker",
      ),
    );
    expect(roster.entries).toEqual([
      { kind: "secret", name: "A_KEY", owner: "request", rotationOnly: false },
      { kind: "secret", name: "B_KEY", owner: "state", rotationOnly: false },
      { kind: "secret", name: "C_KEY", owner: "request", rotationOnly: true },
      { kind: "secret", name: "D_KEY", owner: "state", rotationOnly: true },
      { kind: "localOnly", name: "E_FLAG" },
      { kind: "var", name: "F_VAR", owner: "request" },
      { kind: "var", name: "G_VAR", owner: "state" },
    ]);
  });

  it("stops at the first bare `#` after the rows", () => {
    const roster = parseSecretRoster(
      `${table("#   A_KEY  — request Worker")}#   B_KEY  — state Worker\n`,
    );
    expect(roster.entries.map((entry) => entry.name)).toEqual(["A_KEY"]);
  });

  it("refuses a row whose owner it cannot read", () => {
    expect(() =>
      parseSecretRoster(table("#   A_KEY  — both Workers")),
    ).toThrowError(/A_KEY names no owner/);
  });

  it("refuses a [vars] row that names no Worker", () => {
    expect(() =>
      parseSecretRoster(table("#   F_VAR  — not a secret: a [vars] entry")),
    ).toThrowError(/F_VAR names no owner/);
  });

  it("refuses a row that names two secrets", () => {
    expect(() =>
      parseSecretRoster(
        table(
          "#   A_KEY            — request Worker",
          "#   B_KEY / _SECRET  — request Worker",
        ),
      ),
    ).toThrowError(/unreadable line/);
  });

  it("refuses a line that is neither a row nor its continuation", () => {
    expect(() =>
      parseSecretRoster(table("#   A_KEY  — request Worker", "# stray")),
    ).toThrowError(/unreadable line/);
  });

  it("refuses a name with two rows", () => {
    expect(() =>
      parseSecretRoster(
        table("#   A_KEY  — request Worker", "#   A_KEY  — state Worker"),
      ),
    ).toThrowError(/A_KEY has two rows/);
  });

  it("reads a file checked out with CRLF line endings", () => {
    const roster = parseSecretRoster(
      `${table("#   A_KEY  — request Worker")}A_KEY="x"\n`.replaceAll(
        "\n",
        "\r\n",
      ),
    );
    expect(roster).toEqual({
      entries: [
        {
          kind: "secret",
          name: "A_KEY",
          owner: "request",
          rotationOnly: false,
        },
      ],
      developmentValues: { A_KEY: "x" },
    });
  });

  it("refuses a file with no table", () => {
    expect(() => parseSecretRoster("A_KEY=1\n")).toThrowError(
      /ownership table is missing/,
    );
  });

  it("refuses a table with no rows", () => {
    expect(() => parseSecretRoster(table())).toThrowError(/has no rows/);
  });

  it("reads each assignment's value without its quotes", () => {
    const roster = parseSecretRoster(
      `${table("#   A_KEY  — request Worker")}A_KEY=""\nB_KEY="console"\nC_KEY='[{"a":1}]'\nD_KEY=bare\n# E_KEY="commented"\n`,
    );
    expect(roster.developmentValues).toEqual({
      A_KEY: "",
      B_KEY: "console",
      C_KEY: '[{"a":1}]',
      D_KEY: "bare",
    });
  });
});

describe("the roster in .dev.vars.example", () => {
  const roster = parseSecretRoster(example);
  const names = (kind: string) =>
    roster.entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.name);

  it("names every variable the file assigns, and nothing it does not", () => {
    expect([...names("secret"), ...names("localOnly")].sort()).toEqual(
      Object.keys(roster.developmentValues).sort(),
    );
  });

  it("lists the request Worker's [vars] entries without assigning them", () => {
    expect(
      roster.entries
        .filter((entry) => entry.kind === "var")
        .map((entry) => [entry.name, entry.owner])
        .sort(),
    ).toEqual([
      ["APP_URL", "request"],
      ["DIAGNOSTICS_ENABLED", "request"],
      ["MAIL_FROM_ADDRESS", "request"],
    ]);
  });

  it("marks the three rotation variables, and only them", () => {
    expect(
      roster.entries
        .filter((entry) => entry.kind === "secret" && entry.rotationOnly)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([
      "DIRECTORY_KEY_COMMITMENT",
      "DIRECTORY_ROUTING_KEYRING",
      "IDENTITY_MAIL_ENCRYPTION_KEYRING",
    ]);
  });

  it("marks the development sink and the stub provider as local only", () => {
    expect(names("localOnly").sort()).toEqual([
      "MAIL_DEV_SINK",
      "SSO_DEV_STUB",
    ]);
  });
});

// The roster decides which Worker each secret is uploaded to, so an owner
// written wrong there is a secret on the wrong Worker. This holds each
// row against the code that reads the secret. It sees only reads spelled
// `env.NAME` (including `this.env.NAME`) in non-test `.ts` files under
// `apps/web/app` and `packages/core/src`; a read through destructuring or
// a computed key escapes it.
describe("each secret is read by the Worker the roster gives it to", () => {
  const roster = parseSecretRoster(example);

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" || entry.name === "node_modules"
          ? []
          : sourceFiles(path);
      }
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    });

  const files = [
    ...sourceFiles(resolve(repoRoot, "apps/web/app")),
    ...sourceFiles(resolve(repoRoot, "packages/core/src")),
  ].map((path) => ({
    path: relative(repoRoot, path),
    source: readFileSync(path, "utf8"),
  }));

  // Which Worker runs a file: the state Worker's entry and the Durable
  // Object classes it exports; the request Worker's DI and everything else
  // under `apps/web/app`.
  const workerOf = (path: string): WorkerRole | null => {
    if (
      path === "apps/web/app/worker/cloudflare/state.ts" ||
      /^packages\/core\/src\/adapters\/cloudflare\/\w+DurableObject\.ts$/.test(
        path,
      )
    ) {
      return "state";
    }
    if (
      path.startsWith("apps/web/app/") ||
      path === "packages/core/src/application/di/serverCloudflare.ts"
    ) {
      return "request";
    }
    return null;
  };

  const readersOf = (name: string) =>
    files.filter(({ source }) =>
      new RegExp(`\\benv\\.${name}\\b`).test(source),
    );

  const secrets = roster.entries.flatMap((entry) =>
    entry.kind === "secret" ? [entry] : [],
  );

  it.each(secrets.map((entry) => [entry.name, entry.owner] as const))(
    "%s is read by the %s Worker and not by the other",
    (name, owner) => {
      const readers = readersOf(name).map(({ path }) => ({
        path,
        worker: workerOf(path),
      }));
      expect(readers.map(({ worker }) => worker)).toContain(owner);
      expect(
        readers
          .filter(({ worker }) => worker !== owner)
          .map(({ path }) => path),
      ).toEqual([]);
    },
  );
});
