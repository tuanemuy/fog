#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
type PitrValidationContext = Readonly<{
  now: number;
  headSha: string;
  runUrl: string;
}>;
type GithubWorkflowRun = Readonly<{
  id?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  path?: unknown;
  html_url?: unknown;
  repository?: unknown;
}>;
type GithubArtifact = Readonly<{
  id?: unknown;
  name?: unknown;
  expired?: unknown;
  digest?: unknown;
  workflow_run?: unknown;
}>;
type GithubArtifactList = Readonly<{ artifacts?: unknown }>;
type GithubEnvironment = Readonly<{
  id?: unknown;
  name?: unknown;
  protection_rules?: unknown;
  deployment_branch_policy?: unknown;
}>;
type GithubBranchPolicyList = Readonly<{ branch_policies?: unknown }>;
type GithubApprovalList = readonly unknown[];
type PitrGithubContext = Readonly<{
  repository: string;
  runId: number;
  headSha: string;
}>;

export const MAX_PITR_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60_000;
export const PITR_EVIDENCE_REPOSITORY = "tuanemuy/fog";
export const PITR_EVIDENCE_ENVIRONMENT = "staging-pitr";
export const PITR_EVIDENCE_WORKFLOW =
  ".github/workflows/staging-pitr-smoke.yml";

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
  if (gate.runUrl !== context.runUrl) {
    failures.push(
      "staging PITR evidence does not match the verified workflow run URL",
    );
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

export function requiredPitrEvidenceRunId(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  if (environment.PITR_EVIDENCE_PATH !== undefined) {
    throw new Error(
      "PITR_EVIDENCE_PATH is not trusted; use PITR_EVIDENCE_RUN_ID for the protected workflow run",
    );
  }
  const value = environment.PITR_EVIDENCE_RUN_ID;
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(
      "PITR_EVIDENCE_RUN_ID must identify the protected staging workflow run",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("PITR_EVIDENCE_RUN_ID is outside the safe integer range");
  }
  return parsed;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function validatePitrGithubProvenance(
  input: Readonly<{
    run: GithubWorkflowRun;
    artifactList: GithubArtifactList;
    environment: GithubEnvironment;
    branchPolicies: GithubBranchPolicyList;
    approvals: GithubApprovalList;
  }>,
  context: PitrGithubContext,
): string[] {
  const failures: string[] = [];
  const expectedRunUrl = `https://github.com/${context.repository}/actions/runs/${context.runId}`;
  if (input.run.id !== context.runId) {
    failures.push("PITR workflow run ID does not match");
  }
  if (recordValue(input.run.repository, "full_name") !== context.repository) {
    failures.push("PITR workflow run belongs to another repository");
  }
  if (input.run.head_sha !== context.headSha) {
    failures.push("PITR workflow run does not match the release commit");
  }
  if (input.run.head_branch !== "main") {
    failures.push("PITR workflow run must originate from main");
  }
  if (input.run.event !== "workflow_dispatch") {
    failures.push("PITR workflow run was not manually dispatched");
  }
  if (input.run.status !== "completed" || input.run.conclusion !== "success") {
    failures.push("PITR workflow run did not complete successfully");
  }
  if (
    typeof input.run.path !== "string" ||
    input.run.path.split("@", 1)[0] !== PITR_EVIDENCE_WORKFLOW
  ) {
    failures.push("PITR workflow run used an unexpected workflow file");
  }
  if (input.run.html_url !== expectedRunUrl) {
    failures.push("PITR workflow run has an unexpected URL");
  }

  if (input.environment.name !== PITR_EVIDENCE_ENVIRONMENT) {
    failures.push("staging-pitr environment is missing");
  }
  const protectionRules = Array.isArray(input.environment.protection_rules)
    ? input.environment.protection_rules
    : [];
  const reviewerRule = protectionRules.find(
    (rule) => recordValue(rule, "type") === "required_reviewers",
  );
  const reviewers = recordValue(reviewerRule, "reviewers");
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    failures.push("staging-pitr environment has no required reviewer");
  }
  const reviewerIds = Array.isArray(reviewers)
    ? reviewers
        .map((reviewer) => recordValue(recordValue(reviewer, "reviewer"), "id"))
        .filter(
          (id): id is number =>
            typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        )
    : [];
  if (
    Array.isArray(reviewers) &&
    reviewers.length > 0 &&
    reviewerIds.length === 0
  ) {
    failures.push("staging-pitr environment has no valid required reviewer");
  }
  const approved = input.approvals.some((approval) => {
    if (recordValue(approval, "state") !== "approved") return false;
    const environments = recordValue(approval, "environments");
    const approvedEnvironment =
      Array.isArray(environments) &&
      environments.some(
        (environment) =>
          recordValue(environment, "id") === input.environment.id &&
          recordValue(environment, "name") === PITR_EVIDENCE_ENVIRONMENT,
      );
    const approverId = recordValue(recordValue(approval, "user"), "id");
    return (
      approvedEnvironment &&
      typeof approverId === "number" &&
      reviewerIds.includes(approverId)
    );
  });
  if (!approved) {
    failures.push(
      "PITR workflow run has no staging-pitr approval from a required reviewer",
    );
  }
  if (
    recordValue(
      input.environment.deployment_branch_policy,
      "protected_branches",
    ) !== false ||
    recordValue(
      input.environment.deployment_branch_policy,
      "custom_branch_policies",
    ) !== true
  ) {
    failures.push(
      "staging-pitr environment must use a custom deployment branch policy",
    );
  }
  const branchPolicies = Array.isArray(input.branchPolicies.branch_policies)
    ? input.branchPolicies.branch_policies
    : [];
  if (
    branchPolicies.length !== 1 ||
    recordValue(branchPolicies[0], "name") !== "main" ||
    recordValue(branchPolicies[0], "type") !== "branch"
  ) {
    failures.push("staging-pitr environment does not allow only main releases");
  }

  const artifacts = Array.isArray(input.artifactList.artifacts)
    ? (input.artifactList.artifacts as GithubArtifact[])
    : [];
  const expectedArtifactName = `staging-pitr-${context.headSha}`;
  const matchingArtifacts = artifacts.filter(
    (artifact) => artifact.name === expectedArtifactName,
  );
  if (matchingArtifacts.length !== 1) {
    failures.push(
      "PITR workflow run must contain exactly one commit-bound artifact",
    );
    return failures;
  }
  const artifact = matchingArtifacts[0];
  if (artifact?.expired !== false) {
    failures.push("PITR workflow artifact is expired");
  }
  if (
    typeof artifact?.id !== "number" ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0
  ) {
    failures.push("PITR workflow artifact has no valid ID");
  }
  if (
    typeof artifact?.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
  ) {
    failures.push("PITR workflow artifact has no valid SHA-256 digest");
  }
  if (
    recordValue(artifact?.workflow_run, "id") !== context.runId ||
    recordValue(artifact?.workflow_run, "head_sha") !== context.headSha
  ) {
    failures.push("PITR artifact is not bound to the verified workflow run");
  }
  return failures;
}

export function verifyGithubArtifactDigest(
  archive: Uint8Array,
  expectedDigest: string,
): boolean {
  const actual = createHash("sha256").update(archive).digest("hex");
  return expectedDigest === `sha256:${actual}`;
}

function ghJson<T>(endpoint: string): T {
  return JSON.parse(
    execFileSync("gh", ["api", "--hostname", "github.com", endpoint], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }),
  ) as T;
}

function readVerifiedPitrEvidence(
  runId: number,
  headSha: string,
): Readonly<{ evidence: PitrEvidence; runUrl: string }> {
  const repository = PITR_EVIDENCE_REPOSITORY;
  const run = ghJson<GithubWorkflowRun>(
    `repos/${repository}/actions/runs/${runId}`,
  );
  const artifactList = ghJson<GithubArtifactList>(
    `repos/${repository}/actions/runs/${runId}/artifacts`,
  );
  const environment = ghJson<GithubEnvironment>(
    `repos/${repository}/environments/${PITR_EVIDENCE_ENVIRONMENT}`,
  );
  const branchPolicies = ghJson<GithubBranchPolicyList>(
    `repos/${repository}/environments/${PITR_EVIDENCE_ENVIRONMENT}/deployment-branch-policies`,
  );
  const approvals = ghJson<GithubApprovalList>(
    `repos/${repository}/actions/runs/${runId}/approvals`,
  );
  const provenanceFailures = validatePitrGithubProvenance(
    { run, artifactList, environment, branchPolicies, approvals },
    { repository, runId, headSha },
  );
  if (provenanceFailures.length > 0) {
    throw new Error(provenanceFailures.join("\n"));
  }
  const artifacts = artifactList.artifacts as GithubArtifact[];
  const artifact = artifacts.find(
    ({ name }) => name === `staging-pitr-${headSha}`,
  );
  if (
    artifact === undefined ||
    typeof artifact.id !== "number" ||
    typeof artifact.digest !== "string"
  ) {
    throw new Error("verified PITR artifact metadata is incomplete");
  }
  const archive = execFileSync(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    ],
    { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 },
  );
  if (!verifyGithubArtifactDigest(archive, artifact.digest)) {
    throw new Error("PITR artifact archive digest does not match GitHub");
  }

  const directory = mkdtempSync(resolve(tmpdir(), "fog-pitr-artifact-"));
  const archivePath = resolve(directory, "artifact.zip");
  try {
    writeFileSync(archivePath, archive);
    const entries = execFileSync("unzip", ["-Z1", archivePath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    if (entries.length !== 1 || entries[0] !== "staging.json") {
      throw new Error(
        "PITR artifact must contain exactly one staging.json entry",
      );
    }
    const evidence = JSON.parse(
      execFileSync("unzip", ["-p", archivePath, "staging.json"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ) as PitrEvidence;
    return {
      evidence,
      runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const workingTree = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ).trim();
  if (workingTree.length > 0) {
    throw new Error("release preflight requires a clean committed checkout");
  }
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const runId = requiredPitrEvidenceRunId(process.env);
  const { evidence, runUrl } = readVerifiedPitrEvidence(runId, headSha);
  failures.push(
    ...validatePitrReleaseEvidence([evidence], {
      now: Date.now(),
      headSha,
      runUrl,
    }),
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log(`${stage} release preflight passed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
