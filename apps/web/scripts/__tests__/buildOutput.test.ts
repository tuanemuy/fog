import { describe, expect, it } from "vitest";
import { stageMismatch } from "../lib/buildOutput";

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
