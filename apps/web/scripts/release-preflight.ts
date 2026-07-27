#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Stage = "staging" | "production";
type PitrEvidence = Readonly<{
  name?: unknown;
  result?: unknown;
  stage?: unknown;
  namespace?: unknown;
  verifiedAt?: unknown;
  expiresAt?: unknown;
}>;

function isStage(value: string | undefined): value is Stage {
  return value === "staging" || value === "production";
}

function configValue(source: string, project: string, key: string): string {
  const match = new RegExp(`^\\s*${project}:${key}:\\s*(\\S+)\\s*$`, "mu").exec(
    source,
  );
  if (match?.[1] === undefined) {
    throw new Error(`${project}:${key} is missing`);
  }
  return match[1];
}

export function validateSharedStageConfig(
  resources: string,
  routes: string,
): string[] {
  const resource = {
    accountId: configValue(resources, "fog-cf-resources", "accountId"),
    zoneId: configValue(resources, "fog-cf-resources", "zoneId"),
    hostname: configValue(resources, "fog-cf-resources", "appHostname"),
    prefix: configValue(resources, "fog-cf-resources", "resourcePrefix"),
  };
  const route = {
    accountId: configValue(routes, "fog-cf-routes", "accountId"),
    zoneId: configValue(routes, "fog-cf-routes", "zoneId"),
    hostname: configValue(routes, "fog-cf-routes", "appHostname"),
    workerName: configValue(routes, "fog-cf-routes", "requestWorkerName"),
  };
  const failures: string[] = [];
  for (const key of ["accountId", "zoneId", "hostname"] as const) {
    if (resource[key] !== route[key]) {
      failures.push(
        `${key} differs between resources (${resource[key]}) and routes (${route[key]})`,
      );
    }
  }
  const expectedWorkerName = `${resource.prefix}-request`;
  if (route.workerName !== expectedWorkerName) {
    failures.push(
      `routes requestWorkerName must be ${expectedWorkerName}, got ${route.workerName}`,
    );
  }
  return failures;
}

export function validatePitrReleaseEvidence(
  releaseGates: readonly PitrEvidence[],
  now: number,
): string[] {
  const gate = releaseGates.find(
    ({ name }) => name === "staging PITR bookmark/restore/verify/undo",
  );
  if (gate === undefined) return ["staging PITR release evidence is missing"];
  const failures: string[] = [];
  if (gate.result !== "passed") {
    failures.push(`staging PITR release evidence is ${String(gate.result)}`);
  }
  if (gate.stage !== "staging") {
    failures.push("staging PITR evidence must identify stage=staging");
  }
  if (typeof gate.namespace !== "string" || gate.namespace.length === 0) {
    failures.push(
      "staging PITR evidence must identify the disposable namespace",
    );
  }
  const verifiedAt =
    typeof gate.verifiedAt === "string"
      ? Date.parse(gate.verifiedAt)
      : Number.NaN;
  const expiresAt =
    typeof gate.expiresAt === "string"
      ? Date.parse(gate.expiresAt)
      : Number.NaN;
  if (!Number.isFinite(verifiedAt)) {
    failures.push("staging PITR evidence has no valid verifiedAt");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    failures.push("staging PITR evidence is expired or has no valid expiresAt");
  }
  return failures;
}

function main(): void {
  const stage = process.argv[2];
  if (!isStage(stage)) {
    throw new Error("usage: release-preflight.ts <staging|production>");
  }
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = resolve(webRoot, "../..");
  const pulumiRoot = resolve(repositoryRoot, "infra/cloudflare/pulumi");
  const failures = validateSharedStageConfig(
    readFileSync(resolve(pulumiRoot, `resources/Pulumi.${stage}.yaml`), "utf8"),
    readFileSync(resolve(pulumiRoot, `routes/Pulumi.${stage}.yaml`), "utf8"),
  );
  const results = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, ".thread/19/test-results.json"),
      "utf8",
    ),
  ) as { releaseGates?: readonly PitrEvidence[] };
  failures.push(
    ...validatePitrReleaseEvidence(results.releaseGates ?? [], Date.now()),
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log(`${stage} release preflight passed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
