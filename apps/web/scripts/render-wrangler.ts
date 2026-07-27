#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAuthenticatedOutputs,
  readOfflineOutputs,
  renderWranglerTemplate,
} from "./render-wrangler-lib";

const supportedStages = ["staging", "production"] as const;
type Stage = (typeof supportedStages)[number];

function isStage(value: string): value is Stage {
  return (supportedStages as readonly string[]).includes(value);
}

const offline = process.argv.includes("--offline");
const stageArg = process.argv.find((argument) =>
  (supportedStages as readonly string[]).includes(argument),
);
if (stageArg === undefined || !isStage(stageArg)) {
  console.error(
    `usage: render-wrangler.ts [--offline] <${supportedStages.join("|")}>`,
  );
  process.exit(1);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const resourcesDir = resolve(repoRoot, "infra/cloudflare/pulumi/resources");
const outputs = offline
  ? readOfflineOutputs(resourcesDir, stageArg)
  : readAuthenticatedOutputs(resourcesDir, stageArg, execFileSync);

for (const worker of ["request", "state"] as const) {
  const templatePath = resolve(
    webRoot,
    `wrangler.${worker}.${stageArg}.toml.tpl`,
  );
  const outputPath = resolve(webRoot, `wrangler.${worker}.${stageArg}.toml`);
  const template = readFileSync(templatePath, "utf8");
  const rendered = renderWranglerTemplate(template, outputs);

  writeFileSync(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
}
