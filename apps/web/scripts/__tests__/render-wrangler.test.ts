import type { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  readAuthenticatedOutputs,
  readOfflineOutputs,
  renderWranglerTemplate,
} from "../render-wrangler-lib";

describe("Wrangler stage rendering", () => {
  const placeholder = (name: string) => `$${`{${name}}`}`;

  it.each(["staging", "production"] as const)(
    "renders %s offline from the committed stage fixture",
    (stage) => {
      const outputs = readOfflineOutputs(
        "infra/cloudflare/pulumi/resources",
        stage,
      );
      expect(outputs.exportedAppUrl).toMatch(/^https:\/\//u);
      expect(outputs.exportedPrefix).toBe(`fog-${stage}`);
      expect(
        renderWranglerTemplate(
          `name = "${placeholder("RESOURCE_PREFIX")}-request"\nurl = "${placeholder("APP_URL")}"`,
          outputs,
        ),
      ).not.toContain("${");
    },
  );

  it("fails closed on unknown or unresolved placeholders", () => {
    const outputs = {
      exportedAppUrl: "https://staging.example.com",
      exportedPrefix: "fog-staging",
    };
    expect(() =>
      renderWranglerTemplate(`name = "${placeholder("UNKNOWN")}"`, outputs),
    ).toThrow("Unknown placeholder");
  });

  it("uses authenticated Pulumi stack output only when requested", () => {
    const run = vi.fn(() =>
      JSON.stringify({
        exportedAppUrl: "https://stack.example.com",
        exportedPrefix: "fog-stack",
      }),
    ) as unknown as typeof execFileSync;
    expect(readAuthenticatedOutputs("/resources", "staging", run)).toEqual({
      exportedAppUrl: "https://stack.example.com",
      exportedPrefix: "fog-stack",
    });
    expect(run).toHaveBeenCalledWith(
      "pulumi",
      ["-C", "/resources", "-s", "staging", "stack", "output", "--json"],
      { encoding: "utf8" },
    );
  });
});
