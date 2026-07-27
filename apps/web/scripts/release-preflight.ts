#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Stage = "staging" | "production";
type PitrClass = "user-data" | "identity-directory";
type PitrClassEvidence = Readonly<{
  kind?: unknown;
  result?: unknown;
  target?: unknown;
  restoreReceipt?: unknown;
  undoReceipt?: unknown;
  verification?: unknown;
  verifiedAt?: unknown;
}>;
type PitrEvidence = Readonly<{
  name?: unknown;
  result?: unknown;
  stage?: unknown;
  namespace?: unknown;
  commitSha?: unknown;
  runUrl?: unknown;
  expiresAt?: unknown;
  classes?: unknown;
}>;
type PitrValidationContext = Readonly<{ now: number; headSha: string }>;

export const MAX_PITR_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60_000;

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
  context: PitrValidationContext,
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
  if (gate.commitSha !== context.headSha) {
    failures.push("staging PITR evidence does not match the release commit");
  }
  if (
    typeof gate.runUrl !== "string" ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+(?:\/.*)?$/u.test(
      gate.runUrl,
    )
  ) {
    failures.push("staging PITR evidence has no valid workflow run URL");
  }
  const expiresAt =
    typeof gate.expiresAt === "string"
      ? Date.parse(gate.expiresAt)
      : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= context.now) {
    failures.push("staging PITR evidence is expired or has no valid expiresAt");
  }
  if (!Array.isArray(gate.classes)) {
    failures.push("staging PITR evidence must contain per-class results");
    return failures;
  }
  if (gate.classes.length !== 2) {
    failures.push(
      "staging PITR evidence must contain exactly two class results",
    );
  }
  for (const kind of ["user-data", "identity-directory"] as const) {
    const records = gate.classes.filter(
      (record): record is PitrClassEvidence =>
        typeof record === "object" &&
        record !== null &&
        !Array.isArray(record) &&
        (record as PitrClassEvidence).kind === kind,
    );
    if (records.length !== 1) {
      failures.push(
        `staging PITR evidence must contain exactly one ${kind} result`,
      );
      continue;
    }
    failures.push(
      ...validatePitrClassEvidence(records[0], kind, expiresAt, context),
    );
  }
  return failures;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validReceipt(value: unknown, kind: PitrClass): boolean {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.target)) {
    return false;
  }
  if (
    value.target.kind !== kind ||
    typeof value.restoreBookmark !== "string" ||
    value.restoreBookmark.length === 0 ||
    typeof value.undoBookmark !== "string" ||
    value.undoBookmark.length === 0 ||
    !isRecord(value.proof) ||
    typeof value.proof.id !== "string" ||
    value.proof.id.length === 0 ||
    typeof value.proof.previousSessionId !== "string" ||
    value.proof.previousSessionId.length === 0 ||
    value.proof.undoBookmark !== value.undoBookmark
  ) {
    return false;
  }
  return kind === "user-data"
    ? typeof value.target.accountId === "string" &&
        value.target.accountId.length > 0 &&
        typeof value.target.objectName === "string" &&
        value.target.objectName.length > 0
    : typeof value.target.generation === "string" &&
        value.target.generation.length > 0 &&
        Number.isInteger(value.target.bucket) &&
        Number(value.target.bucket) >= 0 &&
        Number(value.target.bucket) < 64;
}

function validatePitrClassEvidence(
  record: PitrClassEvidence,
  kind: PitrClass,
  expiresAt: number,
  context: PitrValidationContext,
): string[] {
  const failures: string[] = [];
  const prefix = `staging PITR ${kind}`;
  if (record.result !== "passed") {
    failures.push(`${prefix} result is not passed`);
  }
  if (typeof record.target !== "string" || record.target.length === 0) {
    failures.push(`${prefix} evidence has no opaque target`);
  }
  if (!validReceipt(record.restoreReceipt, kind)) {
    failures.push(`${prefix} restore receipt is invalid`);
  }
  if (!validReceipt(record.undoReceipt, kind)) {
    failures.push(`${prefix} undo receipt is invalid`);
  }
  if (
    isRecord(record.restoreReceipt) &&
    isRecord(record.undoReceipt) &&
    record.undoReceipt.restoreBookmark !== record.restoreReceipt.undoBookmark
  ) {
    failures.push(`${prefix} undo does not restore the pre-restore bookmark`);
  }
  if (
    !isRecord(record.verification) ||
    record.verification.restoreComplete !== true ||
    record.verification.undoComplete !== true ||
    (kind === "identity-directory" &&
      (record.verification.conflicts !== 0 ||
        record.verification.cursor !== null))
  ) {
    failures.push(`${prefix} verification is incomplete`);
  }
  const verifiedAt =
    typeof record.verifiedAt === "string"
      ? Date.parse(record.verifiedAt)
      : Number.NaN;
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > context.now ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= verifiedAt ||
    expiresAt - verifiedAt > MAX_PITR_EVIDENCE_TTL_MS
  ) {
    failures.push(`${prefix} evidence is not within the allowed TTL`);
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
  const evidencePath = process.env.PITR_EVIDENCE_PATH;
  if (!evidencePath) {
    throw new Error(
      "PITR_EVIDENCE_PATH must point to the protected staging workflow artifact",
    );
  }
  const evidence = JSON.parse(
    readFileSync(resolve(repositoryRoot, evidencePath), "utf8"),
  ) as PitrEvidence;
  const headSha =
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  failures.push(
    ...validatePitrReleaseEvidence([evidence], {
      now: Date.now(),
      headSha,
    }),
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log(`${stage} release preflight passed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
