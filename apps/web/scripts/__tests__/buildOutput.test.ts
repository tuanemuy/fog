import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildOutputProblem,
  parseDeployBuiltArgs,
  stageMismatch,
} from "../lib/buildOutput";

const builtFrom = (userConfigPath: unknown) => ({ userConfigPath });

describe("stageMismatch", () => {
  it("passes an output built from the stage's rendered request config", () => {
    expect(
      stageMismatch(
        "staging",
        builtFrom("/repo/apps/web/wrangler.staging.toml"),
      ),
    ).toBeNull();
    expect(
      stageMismatch("production", builtFrom("wrangler.production.toml")),
    ).toBeNull();
  });

  it("refuses a local build, naming its source and the build to run", () => {
    const reason = stageMismatch(
      "staging",
      builtFrom("/repo/apps/web/wrangler.toml"),
    );
    expect(reason).toContain("was built from wrangler.toml,");
    expect(reason).toContain("not from wrangler.staging.toml");
    expect(reason).toContain("pnpm build:staging");
  });

  it("refuses another stage's build", () => {
    expect(
      stageMismatch("production", builtFrom("/x/wrangler.staging.toml")),
    ).toContain("was built from wrangler.staging.toml,");
  });

  // The state config's name contains the stage's too; only the request
  // config's own file name counts.
  it("refuses the stage's state config", () => {
    expect(
      stageMismatch("staging", builtFrom("/x/wrangler.state.staging.toml")),
    ).toContain("was built from wrangler.state.staging.toml,");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["no userConfigPath", {}],
    ["a non-string userConfigPath", builtFrom(42)],
  ])("refuses an output config that is %s", (_label, outputConfig) => {
    expect(stageMismatch("staging", outputConfig)).toContain(
      "was built from an unknown config,",
    );
  });
});

describe("buildOutputProblem", () => {
  const dir = mkdtempSync(join(tmpdir(), "fog-build-output-"));
  const fileWith = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds none in an output built from the stage's request config", () => {
    const path = fileWith(
      "ok.json",
      JSON.stringify(builtFrom("/repo/apps/web/wrangler.production.toml")),
    );
    expect(buildOutputProblem("production", path)).toBeNull();
  });

  it("reports the mismatch of an output built from another config", () => {
    const path = fileWith(
      "local.json",
      JSON.stringify(builtFrom("/repo/apps/web/wrangler.toml")),
    );
    expect(buildOutputProblem("production", path)).toBe(
      stageMismatch("production", builtFrom("wrangler.toml")),
    );
    expect(buildOutputProblem("production", path)).toContain(
      "was built from wrangler.toml,",
    );
  });

  it.each([
    ["missing", () => join(dir, "absent.json")],
    ["not JSON", () => fileWith("broken.json", '{"userConfigPath": ')],
  ])(
    "reports an output that is %s, naming the build to run",
    (_label, path) => {
      const problem = buildOutputProblem("staging", path());
      expect(problem).toContain("is missing or unreadable");
      expect(problem).toContain("pnpm build:staging");
    },
  );
});

describe("parseDeployBuiltArgs", () => {
  it("reads a stage alone as an upload", () => {
    expect(parseDeployBuiltArgs(["staging"])).toEqual({
      stage: "staging",
      dryRun: false,
    });
  });

  it("reads --dry-run after the stage as a dry run", () => {
    expect(parseDeployBuiltArgs(["production", "--dry-run"])).toEqual({
      stage: "production",
      dryRun: true,
    });
  });

  // A flag that is ignored leaves `dryRun` false, which is an upload.
  it.each([
    [[]],
    [["prod"]],
    [["--dry-run"]],
    [["--dry-run", "staging"]],
    [["staging", "--dryrun"]],
    [["staging", "--dry-run", "--dry-run"]],
    [["staging", "--dry-run", "extra"]],
    [["staging", "production"]],
  ])("refuses %j", (args) => {
    expect(parseDeployBuiltArgs(args)).toBeNull();
  });
});
