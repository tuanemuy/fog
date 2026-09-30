import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The CLI's own wiring — its arguments, how it calls sops, its exit code —
// run as a process, with a stand-in `sops` first on PATH that logs its
// arguments and prints a fixture. `push` is not run: it needs wrangler's
// credentials, and its wrangler calls are held by `runSecretCommand`'s
// tests and by the upload confirmation.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = mkdtempSync(join(tmpdir(), "stage-secrets-cli-"));
const log = join(dir, "sops.log");

writeFileSync(
  join(dir, "sops"),
  `#!/bin/sh\necho "$@" >> "${log}"\nfile=$(basename "$4")\n[ -f "${dir}/$file" ] || exit 3\ncat "${dir}/$file"\n`,
);
chmodSync(join(dir, "sops"), 0o755);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const request = {
  SESSION_SECRET: "session-secret-value-0123456789abcdef",
  MAIL_PROVIDER_API_KEY: "re_mail-provider-value",
  DIRECTORY_ROUTING_SECRET: "routing-secret-value-0123456789abcdef",
  AI_CLIENT_TOKEN_SECRET: "ai-client-secret-value-0123456789abcd",
  OPERATOR_TOKEN: "operator-token-value-0123456789abcdef",
  GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-client-secret-value",
};
const state = {
  IDENTITY_MAIL_ENCRYPTION_KEY: "encryption-key-value-0123456789abcdef",
  PROVIDER_IDEMPOTENCY_KEY: "idempotency-key-value-0123456789abcd",
  IDENTITY_RESET_TOKEN_KEY: "reset-token-key-value-0123456789abcd",
};

function run(
  args: readonly string[],
  files: Readonly<Record<string, object>> = {},
) {
  rmSync(log, { force: true });
  for (const name of ["staging.request.enc.json", "staging.state.enc.json"]) {
    rmSync(join(dir, name), { force: true });
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  const result = spawnSync(
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/stage-secrets.ts", ...args],
    {
      cwd: webRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
    },
  );
  let sopsCalls: string[] = [];
  try {
    sopsCalls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    sopsCalls = [];
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    sopsCalls,
  };
}

describe("scripts/stage-secrets.ts", () => {
  it.each([[[]], [["check"]], [["upload", "staging"]], [["check", "local"]]])(
    "prints the usage and exits 1 for %j, calling nothing",
    (args) => {
      const { status, output, sopsCalls } = run(args);
      expect(status).toBe(1);
      expect(output).toContain(
        "usage: tsx scripts/stage-secrets.ts <check|push> <staging|production>",
      );
      expect(sopsCalls).toEqual([]);
    },
  );

  it("decrypts both files as JSON and exits 0 when they pass", () => {
    const { status, output, sopsCalls } = run(["check", "staging"], {
      "staging.request.enc.json": request,
      "staging.state.enc.json": state,
    });
    expect(status).toBe(0);
    expect(output).toContain(
      "secrets/staging.request.enc.json and secrets/staging.state.enc.json pass the check",
    );
    expect(sopsCalls).toEqual([
      "--decrypt --output-type json secrets/staging.request.enc.json",
      "--decrypt --output-type json secrets/staging.state.enc.json",
    ]);
  });

  it("exits 1 naming the problem, and prints no value", () => {
    const { status, output } = run(["check", "staging"], {
      "staging.request.enc.json": {
        ...request,
        IDENTITY_MAIL_ENCRYPTION_KEY: state.IDENTITY_MAIL_ENCRYPTION_KEY,
      },
      "staging.state.enc.json": state,
    });
    expect(status).toBe(1);
    expect(output).toContain(
      "secrets/staging.request.enc.json: IDENTITY_MAIL_ENCRYPTION_KEY belongs to the state Worker",
    );
    for (const value of [...Object.values(request), ...Object.values(state)]) {
      expect(output).not.toContain(value);
    }
  });

  it("exits 1 when sops cannot decrypt a file", () => {
    const { status } = run(["check", "staging"], {
      "staging.state.enc.json": state,
    });
    expect(status).toBe(1);
  });
});
