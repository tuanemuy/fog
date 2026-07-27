#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportedStages = ["staging", "production"] as const;
type Stage = (typeof supportedStages)[number];

function isStage(value: string): value is Stage {
  return (supportedStages as readonly string[]).includes(value);
}

const stageArg = process.argv[2];
if (stageArg === undefined || !isStage(stageArg)) {
  console.error(`usage: pnpm cf:render:<${supportedStages.join("|")}>`);
  process.exit(1);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const resourcesDir = resolve(repoRoot, "infra/cloudflare/pulumi/resources");
function stackOutputs(): Record<string, string> {
  try {
    const raw = execFileSync(
      "pulumi",
      ["-C", resourcesDir, "-s", stageArg, "stack", "output", "--json"],
      { encoding: "utf8" },
    );
    return JSON.parse(raw) as Record<string, string>;
  } catch (error) {
    const unavailable =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!unavailable) throw error;
    const yaml = readFileSync(
      resolve(resourcesDir, `Pulumi.${stageArg}.yaml`),
      "utf8",
    );
    const read = (key: string): string => {
      const match = new RegExp(`^[^\\n]*:${key}:\\s*(.+)$`, "mu").exec(yaml);
      if (!match?.[1]) throw new Error(`Missing ${key} in stage config`);
      return match[1].trim();
    };
    return {
      exportedAppUrl: read("appUrl"),
      exportedPrefix: read("resourcePrefix"),
    };
  }
}

const outputs = stackOutputs();
const substitutions: Record<string, string | undefined> = {
  APP_URL: outputs.exportedAppUrl,
  RESOURCE_PREFIX: outputs.exportedPrefix,
};

for (const worker of ["request", "state"] as const) {
  const templatePath = resolve(
    webRoot,
    `wrangler.${worker}.${stageArg}.toml.tpl`,
  );
  const outputPath = resolve(webRoot, `wrangler.${worker}.${stageArg}.toml`);
  const template = readFileSync(templatePath, "utf8");
  const rendered = template.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_match, name: string) => {
      const value = substitutions[name];
      if (value === undefined) {
        throw new Error(`Unknown placeholder \${${name}} in ${templatePath}`);
      }
      return value;
    },
  );

  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
}
