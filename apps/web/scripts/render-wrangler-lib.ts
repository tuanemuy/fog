import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type WranglerStage = "staging" | "production";

export type RenderOutputs = Readonly<{
  exportedAppUrl: string;
  exportedPrefix: string;
}>;

function requireOutput(
  outputs: Record<string, unknown>,
  name: keyof RenderOutputs,
): string {
  const value = outputs[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing Pulumi output ${name}`);
  }
  return value;
}

export function readOfflineOutputs(
  resourcesDir: string,
  stage: WranglerStage,
): RenderOutputs {
  const yaml = readFileSync(
    resolve(resourcesDir, `Pulumi.${stage}.yaml`),
    "utf8",
  );
  const read = (key: string): string => {
    const match = new RegExp(`^[^\\n]*:${key}:\\s*(.+)$`, "mu").exec(yaml);
    const value = match?.[1]?.trim();
    if (value === undefined || value.length === 0 || value.includes("${")) {
      throw new Error(`Missing or unresolved ${key} in offline stage config`);
    }
    return value;
  };
  return {
    exportedAppUrl: read("appUrl"),
    exportedPrefix: read("resourcePrefix"),
  };
}

export function readAuthenticatedOutputs(
  resourcesDir: string,
  stage: WranglerStage,
  run: typeof execFileSync = execFileSync,
): RenderOutputs {
  const raw = run(
    "pulumi",
    ["-C", resourcesDir, "-s", stage, "stack", "output", "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
  return {
    exportedAppUrl: requireOutput(parsed, "exportedAppUrl"),
    exportedPrefix: requireOutput(parsed, "exportedPrefix"),
  };
}

export function renderWranglerTemplate(
  template: string,
  outputs: RenderOutputs,
): string {
  const substitutions: Record<string, string> = {
    APP_URL: outputs.exportedAppUrl,
    RESOURCE_PREFIX: outputs.exportedPrefix,
  };
  const rendered = template.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_match, name: string) => {
      const value = substitutions[name];
      if (value === undefined)
        throw new Error(`Unknown placeholder \${${name}}`);
      return value;
    },
  );
  const unresolved = /\$\{[^}]+\}/u.exec(rendered)?.[0];
  if (unresolved !== undefined) {
    throw new Error(`Unresolved placeholder ${unresolved}`);
  }
  return rendered;
}
