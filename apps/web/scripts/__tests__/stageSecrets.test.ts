import { describe, expect, it } from "vitest";
import type { SecretRoster } from "../lib/secretRoster";
import {
  deployedSecretProblems,
  parseSecretCommandArgs,
  parseSecretFile,
  parseSecretList,
  planSecretUploads,
  runSecretCommand,
  type SecretCommandIo,
  type SecretFile,
  uploadConfirmationProblem,
} from "../lib/stageSecrets";

const roster: SecretRoster = {
  entries: [
    { kind: "secret", name: "REQ_KEY", owner: "request", rotationOnly: false },
    { kind: "secret", name: "REQ_ROT", owner: "request", rotationOnly: true },
    { kind: "secret", name: "STATE_KEY", owner: "state", rotationOnly: false },
    { kind: "secret", name: "STATE_ROT", owner: "state", rotationOnly: true },
    { kind: "secret", name: "REQ_OPT", owner: "request", rotationOnly: true },
    { kind: "localOnly", name: "DEV_SINK" },
    { kind: "var", name: "SOME_VAR", owner: "request" },
  ],
  developmentValues: {
    REQ_KEY: "",
    REQ_ROT: "",
    STATE_KEY: "dev-state-key",
    STATE_ROT: "",
    DEV_SINK: "console",
  },
};

const good = {
  request: { REQ_KEY: "request-secret-value" },
  state: { STATE_KEY: "state-secret-value" },
} as const;

const problemsOf = (files: {
  request: SecretFile;
  state: SecretFile;
}): readonly string[] => {
  const plan = planSecretUploads("staging", files, roster);
  return plan.ok ? [] : plan.problems;
};

describe("planSecretUploads", () => {
  it("plans one upload per Worker, against that Worker's own config", () => {
    expect(planSecretUploads("staging", good, roster)).toEqual({
      ok: true,
      uploads: [
        {
          worker: "state",
          config: "wrangler.state.staging.toml",
          secrets: { STATE_KEY: "state-secret-value" },
        },
        {
          worker: "request",
          config: "wrangler.staging.toml",
          secrets: { REQ_KEY: "request-secret-value" },
        },
      ],
    });
  });

  it("uploads to the production configs for production", () => {
    const plan = planSecretUploads("production", good, roster);
    expect(plan.ok && plan.uploads.map((upload) => upload.config)).toEqual([
      "wrangler.state.production.toml",
      "wrangler.production.toml",
    ]);
  });

  it("carries the rotation variables to their owners when present", () => {
    const plan = planSecretUploads(
      "staging",
      {
        request: { ...good.request, REQ_ROT: "request-rotation" },
        state: { ...good.state, STATE_ROT: "state-rotation" },
      },
      roster,
    );
    expect(plan.ok && plan.uploads.map((upload) => upload.secrets)).toEqual([
      { STATE_KEY: "state-secret-value", STATE_ROT: "state-rotation" },
      { REQ_KEY: "request-secret-value", REQ_ROT: "request-rotation" },
    ]);
  });

  it("drops `_` notes from the check and from the upload", () => {
    const plan = planSecretUploads(
      "staging",
      {
        request: { _readme: 42, ...good.request },
        state: { _: "", ...good.state },
      },
      roster,
    );
    expect(plan.ok && plan.uploads.map((upload) => upload.secrets)).toEqual([
      { STATE_KEY: "state-secret-value" },
      { REQ_KEY: "request-secret-value" },
    ]);
  });

  it.each([
    [
      "a request secret is missing",
      { request: {}, state: good.state },
      "secrets/staging.request.enc.json: REQ_KEY is missing",
    ],
    [
      "a state secret is missing",
      { request: good.request, state: {} },
      "secrets/staging.state.enc.json: STATE_KEY is missing",
    ],
    [
      "a state secret is in the request file",
      { request: { ...good.request, STATE_KEY: "x-value" }, state: good.state },
      "secrets/staging.request.enc.json: STATE_KEY belongs to the state Worker",
    ],
    [
      "a request secret is in the state file",
      { request: good.request, state: { ...good.state, REQ_KEY: "x-value" } },
      "secrets/staging.state.enc.json: REQ_KEY belongs to the request Worker",
    ],
    [
      "a rotation variable is in the other Worker's file",
      { request: { ...good.request, STATE_ROT: "x-value" }, state: good.state },
      "secrets/staging.request.enc.json: STATE_ROT belongs to the state Worker",
    ],
    [
      "a name is not in the roster",
      { request: { ...good.request, UNKNOWN: "x-value" }, state: good.state },
      "secrets/staging.request.enc.json: UNKNOWN is not in the roster of .dev.vars.example",
    ],
    [
      "a [vars] entry is in a secret file",
      { request: good.request, state: { ...good.state, SOME_VAR: "x-value" } },
      "secrets/staging.state.enc.json: SOME_VAR is a [vars] entry, not a secret",
    ],
    [
      "a local-only variable is in a secret file",
      { request: { ...good.request, DEV_SINK: "x-value" }, state: good.state },
      "secrets/staging.request.enc.json: DEV_SINK is local only and must not be deployed",
    ],
    [
      "a value is not a string",
      { request: { REQ_KEY: 12345 }, state: good.state },
      "secrets/staging.request.enc.json: REQ_KEY is not a string",
    ],
    [
      "a value is empty",
      { request: { REQ_KEY: "" }, state: good.state },
      "secrets/staging.request.enc.json: REQ_KEY is empty",
    ],
    [
      "a value is only whitespace",
      { request: { REQ_KEY: " \n" }, state: good.state },
      "secrets/staging.request.enc.json: REQ_KEY is empty",
    ],
    [
      "a present rotation variable is empty",
      { request: { ...good.request, REQ_ROT: "" }, state: good.state },
      "secrets/staging.request.enc.json: REQ_ROT is empty",
    ],
    [
      "a value is empty and the roster assigns it no development value",
      { request: { ...good.request, REQ_OPT: "  " }, state: good.state },
      "secrets/staging.request.enc.json: REQ_OPT is empty",
    ],
    [
      "a value is the development value, padded",
      { request: good.request, state: { STATE_KEY: "  dev-state-key\n" } },
      "secrets/staging.state.enc.json: STATE_KEY still holds the development value from .dev.vars.example",
    ],
  ] as const)("refuses when %s", (_label, files, problem) => {
    expect(planSecretUploads("staging", files, roster)).toEqual({
      ok: false,
      problems: [problem],
    });
  });

  it("names the production files for production", () => {
    const plan = planSecretUploads(
      "production",
      { request: {}, state: good.state },
      roster,
    );
    expect(plan).toEqual({
      ok: false,
      problems: ["secrets/production.request.enc.json: REQ_KEY is missing"],
    });
  });

  it("reports the problems of both files together", () => {
    expect(
      problemsOf({
        request: { REQ_KEY: "request-secret-value", STATE_KEY: "x-value" },
        state: {},
      }),
    ).toEqual([
      "secrets/staging.state.enc.json: STATE_KEY is missing",
      "secrets/staging.request.enc.json: STATE_KEY belongs to the state Worker",
    ]);
  });

  it("never quotes a value in a problem", () => {
    const values = ["value-one-9f2a", "value-two-7c1b", "dev-state-key"];
    const problems = problemsOf({
      request: {
        STATE_KEY: values[0],
        UNKNOWN: values[1],
        DEV_SINK: "console",
      },
      state: { STATE_KEY: `  ${values[2]} `, REQ_KEY: values[1] },
    });
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      for (const value of [...values, "console"]) {
        expect(problem).not.toContain(value);
      }
    }
  });
});

describe("parseSecretFile", () => {
  it("reads a JSON object", () => {
    expect(parseSecretFile('{"A":"b"}', "f")).toEqual({ A: "b" });
  });

  it.each([
    ["[]", "f is not a JSON object"],
    ["null", "f is not a JSON object"],
    ['"text"', "f is not a JSON object"],
    ["{", "f is not JSON"],
  ])("refuses %s", (text, message) => {
    expect(() => parseSecretFile(text, "f")).toThrowError(message);
  });
});

describe("parseSecretList", () => {
  it("keeps the names", () => {
    expect(
      parseSecretList(
        '[{"name":"A","type":"secret_text"},{"name":"B","type":"secret_text"}]',
        "c",
      ),
    ).toEqual(["A", "B"]);
  });

  it.each([
    ["{}", "not an array"],
    ["[{}]", "has an entry with no name"],
    ['[{"name":1}]', "has an entry with no name"],
    ["nope", "not JSON"],
  ])("refuses %s", (text, message) => {
    expect(() => parseSecretList(text, "c")).toThrowError(message);
  });
});

describe("deployedSecretProblems", () => {
  const upload = {
    worker: "state",
    config: "wrangler.state.staging.toml",
    secrets: { STATE_KEY: "state-secret-value" },
  } as const;

  it("is quiet when the Worker holds exactly what it was sent", () => {
    expect(deployedSecretProblems(upload, ["STATE_KEY"], roster)).toEqual([]);
  });

  it("names a secret the other Worker owns, and how to delete it", () => {
    expect(
      deployedSecretProblems(upload, ["STATE_KEY", "REQ_KEY"], roster),
    ).toEqual([
      "the state Worker holds REQ_KEY, but it belongs to the request Worker. " +
        "Delete it with `wrangler secret delete REQ_KEY --config wrangler.state.staging.toml`",
    ]);
  });

  it("names a secret left behind after it left the file", () => {
    expect(
      deployedSecretProblems(upload, ["STATE_KEY", "STATE_ROT"], roster),
    ).toEqual([
      "the state Worker holds STATE_ROT, but it is not in the secret file. " +
        "Delete it with `wrangler secret delete STATE_ROT --config wrangler.state.staging.toml`",
    ]);
  });

  it("names a secret the upload did not leave on the Worker", () => {
    expect(deployedSecretProblems(upload, [], roster)).toEqual([
      "the state Worker does not hold STATE_KEY after the upload",
    ]);
  });
});

describe("runSecretCommand", () => {
  const encrypted = (files: { request: SecretFile; state: SecretFile }) => ({
    "secrets/staging.request.enc.json": JSON.stringify(files.request),
    "secrets/staging.state.enc.json": JSON.stringify(files.state),
  });

  const fakeIo = (
    files: { request: SecretFile; state: SecretFile },
    deployed: Record<string, readonly string[]> = {
      "wrangler.staging.toml": ["REQ_KEY"],
      "wrangler.state.staging.toml": ["STATE_KEY"],
    },
    confirmed = true,
  ) => {
    const byPath: Record<string, string> = encrypted(files);
    const calls: string[] = [];
    const reports: string[] = [];
    const io: SecretCommandIo = {
      decrypt: (file) => {
        calls.push(`decrypt ${file}`);
        const text = byPath[file];
        if (text === undefined) throw new Error(`no fixture for ${file}`);
        return text;
      },
      upload: (config, json) => {
        calls.push(`upload ${config} ${json}`);
        const count = Object.keys(JSON.parse(json) as object).length;
        return confirmed ? `✨ ${count} secrets successfully uploaded\n` : "";
      },
      list: (config) => {
        calls.push(`list ${config}`);
        return JSON.stringify(
          (deployed[config] ?? []).map((name) => ({
            name,
            type: "secret_text",
          })),
        );
      },
      report: (line) => {
        reports.push(line);
      },
    };
    return { io, calls, reports };
  };

  it("check decrypts both files and uploads nothing", () => {
    const { io, calls } = fakeIo(good);
    expect(
      runSecretCommand({ command: "check", stage: "staging" }, roster, io),
    ).toBe(true);
    expect(calls).toEqual([
      "decrypt secrets/staging.request.enc.json",
      "decrypt secrets/staging.state.enc.json",
    ]);
  });

  it("check fails on a problem and reports it", () => {
    const { io, reports } = fakeIo({ request: {}, state: good.state });
    expect(
      runSecretCommand({ command: "check", stage: "staging" }, roster, io),
    ).toBe(false);
    expect(reports).toEqual([
      "secrets/staging.request.enc.json: REQ_KEY is missing",
    ]);
  });

  it("push uploads each Worker's own secrets over stdin, then lists both", () => {
    const { io, calls } = fakeIo({
      request: { _readme: "note", ...good.request },
      state: good.state,
    });
    expect(
      runSecretCommand({ command: "push", stage: "staging" }, roster, io),
    ).toBe(true);
    expect(calls.slice(2)).toEqual([
      'upload wrangler.state.staging.toml {"STATE_KEY":"state-secret-value"}',
      'upload wrangler.staging.toml {"REQ_KEY":"request-secret-value"}',
      "list wrangler.state.staging.toml",
      "list wrangler.staging.toml",
    ]);
  });

  it("push uploads to neither Worker when only one file has a problem", () => {
    const { io, calls } = fakeIo({
      request: good.request,
      state: { ...good.state, DEV_SINK: "console" },
    });
    expect(
      runSecretCommand({ command: "push", stage: "staging" }, roster, io),
    ).toBe(false);
    expect(calls.filter((call) => !call.startsWith("decrypt"))).toEqual([]);
  });

  it("push fails when a Worker still holds a secret its file does not have", () => {
    const { io, reports } = fakeIo(good, {
      "wrangler.staging.toml": ["REQ_KEY", "REQ_ROT"],
      "wrangler.state.staging.toml": ["STATE_KEY"],
    });
    expect(
      runSecretCommand({ command: "push", stage: "staging" }, roster, io),
    ).toBe(false);
    expect(reports.at(-1)).toMatch(/^the request Worker holds REQ_ROT/);
  });

  it("push fails when wrangler does not confirm an upload", () => {
    const { io, reports } = fakeIo(good, undefined, false);
    expect(
      runSecretCommand({ command: "push", stage: "staging" }, roster, io),
    ).toBe(false);
    expect(reports).toContain(
      "wrangler did not confirm uploading 1 secrets to the request Worker",
    );
  });
});

describe("uploadConfirmationProblem", () => {
  const upload = {
    worker: "request",
    config: "wrangler.staging.toml",
    secrets: { A: "a-value", B: "b-value" },
  } as const;

  it("accepts wrangler's count of the whole upload", () => {
    expect(
      uploadConfirmationProblem(
        upload,
        "🌀 Creating the secrets\n✨ 2 secrets successfully uploaded\n",
      ),
    ).toBeNull();
  });

  it.each([
    ["no confirmation", "🚨 No content found in file, or piped input."],
    ["a short count", "✨ 1 secrets successfully uploaded"],
    ["a count that only ends like it", "✨ 12 secrets successfully uploaded"],
  ])("refuses %s", (_label, output) => {
    expect(uploadConfirmationProblem(upload, output)).toBe(
      "wrangler did not confirm uploading 2 secrets to the request Worker",
    );
  });
});

describe("parseSecretCommandArgs", () => {
  it.each([
    [["check", "staging"], { command: "check", stage: "staging" }],
    [["push", "production"], { command: "push", stage: "production" }],
  ])("reads %j", (args, expected) => {
    expect(parseSecretCommandArgs(args)).toEqual(expected);
  });

  it.each([
    [[]],
    [["check"]],
    [["deploy", "staging"]],
    [["check", "local"]],
    [["push", "staging", "--dry-run"]],
  ])("refuses %j", (args) => {
    expect(parseSecretCommandArgs(args)).toBeNull();
  });
});
