import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_STAGES,
  isDeployStage,
  templateFileOf,
  wranglerConfigFiles,
} from "../lib/deployStage";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("wranglerConfigFiles", () => {
  it("resolves no stage to the local pair", () => {
    expect(wranglerConfigFiles(null)).toEqual({
      request: "wrangler.toml",
      state: "wrangler.state.toml",
    });
  });

  it("resolves a stage to that stage's rendered pair", () => {
    expect(wranglerConfigFiles("staging")).toEqual({
      request: "wrangler.staging.toml",
      state: "wrangler.state.staging.toml",
    });
    expect(wranglerConfigFiles("production")).toEqual({
      request: "wrangler.production.toml",
      state: "wrangler.state.production.toml",
    });
  });

  it.each(DEPLOY_STAGES)(
    "every rendered %s config has its committed template",
    (stage) => {
      const { request, state } = wranglerConfigFiles(stage);
      for (const file of [request, state]) {
        expect(templateFileOf(file)).toBe(`${file}.tpl`);
        expect(existsSync(resolve(webRoot, templateFileOf(file)))).toBe(true);
      }
    },
  );
});

describe("isDeployStage", () => {
  it.each(DEPLOY_STAGES)("accepts %s", (stage) => {
    expect(isDeployStage(stage)).toBe(true);
  });

  it.each(["", "prod", "Staging", "staging ", "local"])(
    "rejects %j",
    (value) => {
      expect(isDeployStage(value)).toBe(false);
    },
  );
});

// A stage build is selected by its Vite config file and by nothing else, so
// each file has to hand `createConfig` its own stage and the default config
// has to hand it none.
describe("the Vite configs select their own stage", () => {
  const createConfigCall = (file: string) =>
    /^export default createConfig\((.*)\);$/m.exec(
      readFileSync(resolve(webRoot, file), "utf8"),
    )?.[1];

  it("vite.config.cloudflare.ts builds against the local pair", () => {
    expect(createConfigCall("vite.config.cloudflare.ts")).toBe("null");
  });

  it.each(DEPLOY_STAGES)("vite.config.cloudflare.%s.ts", (stage) => {
    expect(createConfigCall(`vite.config.cloudflare.${stage}.ts`)).toBe(
      `"${stage}"`,
    );
  });
});
