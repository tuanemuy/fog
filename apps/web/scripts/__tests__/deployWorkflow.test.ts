import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEPLOY_STAGES,
  type DeployStage,
  secretFiles,
  type WorkerRole,
} from "../lib/deployStage";
import { parseSecretRoster } from "../lib/secretRoster";
import { planSecretUploads } from "../lib/stageSecrets";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(webRoot, "../..");
const readYaml = (path: string): unknown =>
  parse(readFileSync(resolve(repoRoot, path), "utf8"));

/**
 * The keys of a would-be sops file whose values are not encrypted, and
 * `sops` if its metadata is missing or carries no MAC. sops leaves an empty value as it is,
 * and an empty value gives nothing away.
 */
function unencryptedKeys(text: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return ["(not JSON)"];
  }
  const plain = Object.entries(parsed).flatMap(([key, value]) =>
    key === "sops" ||
    value === "" ||
    (typeof value === "string" && value.startsWith("ENC["))
      ? []
      : [key],
  );
  const { sops } = parsed;
  const sealed =
    typeof sops === "object" &&
    sops !== null &&
    "mac" in sops &&
    typeof sops.mac === "string";
  return sealed ? plain : [...plain, "sops"];
}

type Step = Readonly<{
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: unknown;
  if?: unknown;
}>;

type Job = Readonly<{
  environment?: string;
  env?: Record<string, string>;
  "continue-on-error"?: unknown;
  if?: unknown;
  steps: Step[];
}>;

/** The repository secrets a piece of workflow YAML refers to, wherever in it. */
const secretsReferencedBy = (node: unknown): string[] =>
  [
    ...JSON.stringify(node ?? null).matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g),
  ].map((match) => match[1] ?? "");

type CallerWorkflow = Readonly<{
  on: Record<string, unknown>;
  concurrency: Record<string, unknown>;
  jobs: Record<
    string,
    { uses?: string; with?: Record<string, unknown>; secrets?: unknown }
  >;
}>;

const CALLERS: ReadonlyArray<readonly [DeployStage, string]> = [
  ["staging", ".github/workflows/deploy-staging.yml"],
  ["production", ".github/workflows/deploy-production.yml"],
];

describe("the deploy workflow of each stage", () => {
  it("covers every stage", () => {
    expect(CALLERS.map(([stage]) => stage).sort()).toEqual(
      [...DEPLOY_STAGES].sort(),
    );
  });

  it("staging deploys every push to main, and on demand", () => {
    const { on } = readYaml(CALLERS[0][1]) as CallerWorkflow;
    expect(Object.keys(on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(on.push).toEqual({ branches: ["main"] });
  });

  it("production deploys every version tag, and on demand", () => {
    const { on } = readYaml(CALLERS[1][1]) as CallerWorkflow;
    expect(Object.keys(on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(on.push).toEqual({ tags: ["v*.*.*"] });
  });

  // A deploy cut off between the two Workers leaves the state Worker
  // ahead of the request Worker, so a run is queued behind the one in
  // progress rather than cancelling it.
  it.each(CALLERS)(
    "%s runs one deploy at a time and never cancels one",
    (stage, path) => {
      const { concurrency } = readYaml(path) as CallerWorkflow;
      expect(concurrency).toEqual({
        group: `deploy-${stage}`,
        "cancel-in-progress": false,
      });
    },
  );

  it.each(CALLERS)(
    "%s runs the shared deploy with its own stage name",
    (stage, path) => {
      const { jobs } = readYaml(path) as CallerWorkflow;
      expect(Object.values(jobs)).toEqual([
        {
          uses: "./.github/workflows/deploy.yml",
          with: { stage },
          secrets: "inherit",
        },
      ]);
    },
  );
});

describe("the shared deploy", () => {
  const workflow = readYaml(".github/workflows/deploy.yml") as {
    jobs: Record<string, Job>;
  };
  const [job, ...others] = Object.values(workflow.jobs);
  const steps = job?.steps ?? [];

  it("is one job, run in the stage's GitHub environment", () => {
    expect(others).toEqual([]);
    // The environment carries the stage's secrets and, for production,
    // the required reviewers that hold the run for approval.
    expect(job?.environment).toMatch(/^\$\{\{ inputs\.stage \}\}$/);
  });

  const indexOf = (label: string, match: (step: Step) => boolean) => {
    const found = steps.filter(match);
    expect(found, label).toHaveLength(1);
    return steps.indexOf(found[0] as Step);
  };
  const pulumiUp = (dir: string) => (step: Step) =>
    step.uses?.startsWith("pulumi/actions@") === true &&
    step.with?.command === "up" &&
    step.with?.["work-dir"] === `infra/cloudflare/pulumi/${dir}`;
  const runs = (pattern: RegExp) => (step: Step) =>
    step.run !== undefined && pattern.test(step.run);

  const order = [
    indexOf("check", runs(/^pnpm secrets:check "\$STAGE"$/)),
    indexOf("resources", pulumiUp("resources")),
    indexOf("render", runs(/^pnpm "cf:render:\$STAGE"$/)),
    indexOf("retention", runs(/wrangler queues update /)),
    indexOf("deploy", runs(/^pnpm "deploy:\$STAGE:all"$/)),
    indexOf("push", runs(/^pnpm secrets:push "\$STAGE"$/)),
    indexOf("routes", pulumiUp("routes")),
  ];

  it("checks the secrets, provisions, renders, sets the retention, deploys, uploads the secrets, then binds the hostname", () => {
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  // A failing step has to stop the run: the check above all, since the
  // steps after it touch Cloudflare and Pulumi.
  // A failing step has to stop the run, and nothing after it may run
  // anyway — `continue-on-error`, or an `if:` such as `always()`.
  it("lets no step fail without failing the run", () => {
    expect(job?.["continue-on-error"]).toBeUndefined();
    expect(job?.if).toBeUndefined();
    for (const step of steps) {
      expect(step["continue-on-error"], step.name).toBeUndefined();
      expect(step.if, step.name).toBeUndefined();
    }
  });

  // A job-level `env` would reach every step, `pnpm install`'s lifecycle
  // scripts included; the credentials are handed to steps one by one.
  it("sets nothing but the stage name for the whole job", () => {
    expect(Object.keys(job?.env ?? {})).toEqual(["STAGE"]);
    expect(job?.env?.STAGE).toMatch(/^\$\{\{ inputs\.stage \}\}$/);
    const { steps: _steps, ...jobLevel } = job ?? { steps: [] };
    expect(secretsReferencedBy(jobLevel)).toEqual([]);
  });

  it("points every Pulumi and wrangler step at the run's own stage", () => {
    for (const dir of ["resources", "routes"]) {
      const step = steps.find(pulumiUp(dir));
      expect(step?.with?.["stack-name"]).toMatch(/^\$\{\{ inputs\.stage \}\}$/);
    }
    expect(steps.find(runs(/wrangler queues update /))?.run).toMatch(
      / -s "\$STAGE" /,
    );
  });

  it("pins the Pulumi CLI and the sops release, and checks sops against its digest", () => {
    for (const dir of ["resources", "routes"]) {
      expect(steps.find(pulumiUp(dir))?.with?.["pulumi-version"]).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
    const sops = steps.filter((step) =>
      step.run?.includes("/usr/local/bin/sops"),
    );
    expect(sops).toHaveLength(1);
    expect(sops[0]?.env?.SOPS_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(sops[0]?.env?.SOPS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const lines = (sops[0]?.run ?? "").trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "curl",
      "echo",
      "sudo",
    ]);
    expect(lines[1]).toBe(
      'echo "$SOPS_SHA256  $RUNNER_TEMP/sops" | sha256sum --check --strict',
    );
  });

  // The check runs before anything reaches Cloudflare or Pulumi, so a bad
  // secret file fails the run with nothing touched.
  it("hands no secret at all to a step before the secret check", () => {
    const beforeCheck = steps.slice(0, order[0]);
    for (const step of beforeCheck) {
      expect(step.uses?.startsWith("pulumi/") ?? false).toBe(false);
      expect(secretsReferencedBy(step), step.name).toEqual([]);
    }
  });

  it("uploads Worker code only through the stage's deploy script", () => {
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/wrangler (deploy|versions)/);
      expect(step.uses ?? "").not.toMatch(/^cloudflare\/wrangler-action/);
    }
  });

  it("gives the age key only to the two secret steps", () => {
    const holders = steps.filter((step) =>
      secretsReferencedBy(step).includes("SOPS_AGE_KEY"),
    );
    expect(holders.map((step) => step.run)).toEqual([
      'pnpm secrets:check "$STAGE"',
      'pnpm secrets:push "$STAGE"',
    ]);
  });
});

type CreationRule = Readonly<{
  path_regex: string;
  encrypted_regex?: string;
  age?: string;
}>;

describe(".sops.yaml", () => {
  const rules = (readYaml(".sops.yaml") as { creation_rules: CreationRule[] })
    .creation_rules;
  const rulesFor = (path: string) =>
    rules.filter((rule) => new RegExp(rule.path_regex).test(path));

  it.each(
    DEPLOY_STAGES.flatMap((stage) =>
      Object.values(secretFiles(stage)).map((file) => [stage, file] as const),
    ),
  )("%s: apps/web/%s falls under exactly one rule", (_stage, file) => {
    expect(rulesFor(`apps/web/${file}`)).toHaveLength(1);
  });

  // Sharing a recipient would let one stage's key decrypt the other's secrets.
  it("encrypts each stage to its own recipient", () => {
    const recipients = DEPLOY_STAGES.map((stage) => {
      const files = Object.values(secretFiles(stage));
      const [rule] = rulesFor(`apps/web/${files[0]}`);
      for (const file of files) {
        expect(rulesFor(`apps/web/${file}`)).toEqual([rule]);
      }
      return rule?.age;
    });
    expect(recipients.every((age) => typeof age === "string")).toBe(true);
    expect(new Set(recipients).size).toBe(DEPLOY_STAGES.length);
  });

  it("encrypts every value", () => {
    for (const rule of rules) {
      expect(rule.encrypted_regex).toBe("^(.+)$");
    }
  });
});

// A secret file is committable under its `.enc.json` name before it is
// encrypted, so every one in the tree must carry sops metadata and hold
// nothing but encrypted values.
describe("the committed secret files", () => {
  const files = readdirSync(resolve(webRoot, "secrets")).filter((name) =>
    name.endsWith(".enc.json"),
  );

  it("are only the stages' own files", () => {
    const expected = DEPLOY_STAGES.flatMap((stage) =>
      Object.values(secretFiles(stage)).map((file) =>
        file.slice("secrets/".length),
      ),
    );
    for (const file of files) expect(expected).toContain(file);
  });

  it.each(files.map((file) => [file]))("%s is encrypted", (file) => {
    expect(
      unencryptedKeys(readFileSync(resolve(webRoot, "secrets", file), "utf8")),
    ).toEqual([]);
  });
});

describe("unencryptedKeys", () => {
  it("accepts a sops file", () => {
    expect(
      unencryptedKeys(
        JSON.stringify({
          A: "ENC[AES256_GCM,data:x,type:str]",
          B: "",
          sops: { mac: "ENC[AES256_GCM,data:m,type:str]" },
        }),
      ),
    ).toEqual([]);
  });

  it("names a file whose metadata carries no MAC", () => {
    expect(unencryptedKeys(JSON.stringify({ A: "", sops: {} }))).toEqual([
      "sops",
    ]);
  });

  it("names every plaintext value, and a file without metadata", () => {
    expect(
      unencryptedKeys(
        JSON.stringify({ A: "ENC[AES256_GCM,data:x]", B: "plain", C: 1 }),
      ),
    ).toEqual(["B", "C", "sops"]);
  });

  it("names a file that is not JSON", () => {
    expect(unencryptedKeys("A=plain")).toEqual(["(not JSON)"]);
  });
});

describe("the plaintext templates of the secret files", () => {
  const roster = parseSecretRoster(
    readFileSync(resolve(webRoot, ".dev.vars.example"), "utf8"),
  );
  const template = (worker: WorkerRole): Record<string, unknown> =>
    JSON.parse(
      readFileSync(resolve(webRoot, `secrets/${worker}.json.example`), "utf8"),
    ) as Record<string, unknown>;

  it.each(["request", "state"] as const)(
    "%s lists exactly the secrets its Worker requires",
    (worker) => {
      const required = roster.entries.flatMap((entry) =>
        entry.kind === "secret" && entry.owner === worker && !entry.rotationOnly
          ? [entry.name]
          : [],
      );
      expect(
        Object.keys(template(worker))
          .filter((key) => !key.startsWith("_"))
          .sort(),
      ).toEqual(required.sort());
    },
  );

  // Encrypted without being filled in, a template must not pass the check.
  it("fails the check when encrypted as it is", () => {
    const plan = planSecretUploads(
      "staging",
      { request: template("request"), state: template("state") },
      roster,
    );
    const keys = [
      ...Object.keys(template("request")),
      ...Object.keys(template("state")),
    ].filter((key) => !key.startsWith("_"));
    expect(plan).toEqual({
      ok: false,
      problems: expect.arrayContaining(
        keys.map((key) => expect.stringContaining(`: ${key} is empty`)),
      ),
    });
  });
});
