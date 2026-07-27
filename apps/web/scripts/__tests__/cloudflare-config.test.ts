import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stages = ["", ".staging", ".production"] as const;

function config(worker: "request" | "state", stage: string): string {
  const template = stage === "" ? "" : ".tpl";
  return readFileSync(
    `apps/web/wrangler.${worker}${stage}.toml${template}`,
    "utf8",
  );
}

describe("Cloudflare two-Worker configuration", () => {
  for (const stage of stages) {
    it(`keeps request/state bindings and secrets separated for ${stage || "local"}`, () => {
      const request = config("request", stage);
      const state = config("state", stage);
      const stateName = /name = "([^"]+-state)"/u.exec(state)?.[1];
      expect(stateName).toBeDefined();
      for (const [binding, className] of [
        ["USER_DATA", "UserDataDurableObject"],
        ["IDENTITY_DIRECTORY", "IdentityDirectoryDurableObject"],
        ["ACCOUNT_HOME", "AccountHomeDurableObject"],
      ]) {
        expect(request).toContain(`name = "${binding}"`);
        expect(request).toContain(`class_name = "${className}"`);
        expect(request).toContain(`script_name = "${stateName}"`);
        expect(state).toContain(`[exports.${className}]`);
        expect(state).toContain('storage = "sqlite"');
      }
      expect(request).toContain("PITR_OPERATOR_TOKEN");
      expect(state).toContain("required = []");
      expect(state).not.toMatch(
        /SESSION_SECRET|DIRECTORY_ROUTING_SECRET|PITR_OPERATOR_TOKEN/u,
      );
      expect(request).not.toContain("wrangler.lifecycle.toml");
    });
  }

  it("builds each stage with the matching Vite/Wrangler mode", () => {
    expect(config("request", "")).toContain("--mode development");
    expect(config("request", ".staging")).toContain("--mode staging");
    expect(config("request", ".production")).toContain("--mode production");
    const vite = readFileSync("apps/web/vite.config.cloudflare.ts", "utf8");
    expect(vite).toContain('staging: "./wrangler.request.staging.toml"');
    expect(vite).toContain('production: "./wrangler.request.production.toml"');
  });

  it("keeps raw semantic commits out of the production state artifact", () => {
    const production = readFileSync(
      "apps/web/app/durable-objects/UserDataDurableObject.ts",
      "utf8",
    );
    const local = readFileSync(
      "apps/web/app/testing/LocalUserDataDurableObject.ts",
      "utf8",
    );
    const productionEntry = readFileSync(
      "apps/web/app/server.state.ts",
      "utf8",
    );
    expect(production).not.toMatch(/\basync\s+commit\s*\(/u);
    expect(local).toMatch(/\basync\s+commit\s*\(/u);
    expect(productionEntry).not.toContain("LocalUserDataDurableObject");
  });

  it("treats the DNS zone as shared existing infrastructure", () => {
    const resources = readFileSync(
      "infra/cloudflare/pulumi/resources/index.ts",
      "utf8",
    );
    expect(resources).toContain('config.require("zoneId")');
    expect(resources).not.toMatch(/new\s+cloudflare\.Zone/u);
    const zoneIds = [".staging", ".production"].map(
      (stage) =>
        /fog-cf-resources:zoneId:\s*(\S+)/u.exec(
          readFileSync(
            `infra/cloudflare/pulumi/resources/Pulumi${stage}.yaml`,
            "utf8",
          ),
        )?.[1],
    );
    expect(zoneIds).toEqual([
      "REPLACE_WITH_SHARED_CF_ZONE_ID",
      "REPLACE_WITH_SHARED_CF_ZONE_ID",
    ]);
    for (const stage of ["staging", "production"]) {
      const resourcesConfig = readFileSync(
        `infra/cloudflare/pulumi/resources/Pulumi.${stage}.yaml`,
        "utf8",
      );
      const routesConfig = readFileSync(
        `infra/cloudflare/pulumi/routes/Pulumi.${stage}.yaml`,
        "utf8",
      );
      for (const key of ["accountId", "zoneId", "appHostname"]) {
        const resourceValue = new RegExp(
          `fog-cf-resources:${key}:\\s*(\\S+)`,
          "u",
        ).exec(resourcesConfig)?.[1];
        const routeValue = new RegExp(
          `fog-cf-routes:${key}:\\s*(\\S+)`,
          "u",
        ).exec(routesConfig)?.[1];
        expect(routeValue).toBe(resourceValue);
      }
    }
  });
});
