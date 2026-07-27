import { describe, expect, it } from "vitest";
import {
  MAX_PITR_EVIDENCE_TTL_MS,
  requiredPitrEvidenceRunId,
  validatePitrGithubProvenance,
  validatePitrReleaseEvidence,
  validateSharedStageConfig,
  verifyGithubArtifactDigest,
} from "../release-preflight";

const resources = `config:
  fog-cf-resources:accountId: account
  fog-cf-resources:zoneId: shared-zone
  fog-cf-resources:appHostname: staging.example.com
  fog-cf-resources:resourcePrefix: fog-staging
`;
const routes = `config:
  fog-cf-routes:accountId: account
  fog-cf-routes:zoneId: shared-zone
  fog-cf-routes:appHostname: staging.example.com
  fog-cf-routes:requestWorkerName: fog-staging-request
`;

describe("release preflight", () => {
  it("requires resources and routes to share account, zone, and hostname", () => {
    expect(validateSharedStageConfig(resources, routes)).toEqual([]);
    expect(
      validateSharedStageConfig(
        resources,
        routes.replace("shared-zone", "different-zone"),
      ),
    ).toEqual([
      "zoneId differs between resources (shared-zone) and routes (different-zone)",
    ]);
  });

  it("requires fresh, stage-scoped PITR evidence", () => {
    const now = Date.parse("2026-07-28T00:00:00Z");
    const headSha = "a".repeat(40);
    const receipt = (
      kind: "user-data" | "identity-directory",
      restoreBookmark: string,
      undoBookmark: string,
    ) => ({
      version: 2,
      target:
        kind === "user-data"
          ? {
              kind,
              accountId: "opaque-account",
              objectName: "canonical-user-data",
            }
          : { kind, generation: "staging-v1", bucket: 3 },
      restoreBookmark,
      undoBookmark,
      proof: {
        id: `${kind}-${restoreBookmark}`,
        previousSessionId: `${kind}-session`,
        undoBookmark,
      },
    });
    const classEvidence = (kind: "user-data" | "identity-directory") => ({
      kind,
      result: "passed",
      target: `${kind}-opaque-target`,
      restoreReceipt: receipt(kind, "old", "before-restore"),
      undoReceipt: receipt(kind, "before-restore", "after-restore"),
      verification: {
        restoreComplete: true,
        undoComplete: true,
        ...(kind === "identity-directory"
          ? { conflicts: 0, cursor: null }
          : {}),
      },
      verifiedAt: "2026-07-27T00:00:00Z",
    });
    expect(
      validatePitrReleaseEvidence(
        [
          {
            name: "staging PITR bookmark/restore/verify/undo",
            result: "passed",
            stage: "staging",
            namespace: "fog-staging-pitr-disposable",
            commitSha: headSha,
            runUrl: "https://github.com/tuanemuy/fog/actions/runs/123456789",
            expiresAt: new Date(
              Date.parse("2026-07-27T00:00:00Z") + MAX_PITR_EVIDENCE_TTL_MS,
            ).toISOString(),
            classes: [
              classEvidence("user-data"),
              classEvidence("identity-directory"),
            ],
          },
        ],
        {
          now,
          headSha,
          runUrl: "https://github.com/tuanemuy/fog/actions/runs/123456789",
        },
      ),
    ).toEqual([]);
    expect(
      validatePitrReleaseEvidence(
        [
          {
            name: "staging PITR bookmark/restore/verify/undo",
            result: "pending",
            stage: "staging",
          },
        ],
        {
          now,
          headSha,
          runUrl: "https://github.com/tuanemuy/fog/actions/runs/123456789",
        },
      ),
    ).toEqual([
      "staging PITR release evidence is pending",
      "staging PITR evidence must identify the disposable namespace",
      "staging PITR evidence does not match the release commit",
      "staging PITR evidence does not match the verified workflow run URL",
      "staging PITR evidence is expired or has no valid expiresAt",
      "staging PITR evidence must contain per-class results",
    ]);
  });

  it("rejects one-class, future, stale, and cross-target PITR evidence", () => {
    const now = Date.parse("2026-07-28T00:00:00Z");
    const headSha = "a".repeat(40);
    const restoreReceipt = {
      version: 2,
      target: {
        kind: "user-data",
        accountId: "opaque",
        objectName: "canonical",
      },
      restoreBookmark: "old",
      undoBookmark: "before",
      proof: {
        id: "proof",
        previousSessionId: "session",
        undoBookmark: "before",
      },
    };
    const failures = validatePitrReleaseEvidence(
      [
        {
          name: "staging PITR bookmark/restore/verify/undo",
          result: "passed",
          stage: "staging",
          namespace: "disposable",
          commitSha: "b".repeat(40),
          runUrl: "not-a-run-url",
          expiresAt: "2026-08-20T00:00:00Z",
          classes: [
            {
              kind: "user-data",
              result: "passed",
              target: "opaque",
              restoreReceipt,
              undoReceipt: {
                ...restoreReceipt,
                restoreBookmark: "wrong-bookmark",
              },
              verification: {
                restoreComplete: true,
                undoComplete: true,
              },
              verifiedAt: "2026-07-29T00:00:00Z",
            },
          ],
        },
      ],
      {
        now,
        headSha,
        runUrl: "https://github.com/tuanemuy/fog/actions/runs/123456789",
      },
    );

    expect(failures).toContain(
      "staging PITR evidence does not match the release commit",
    );
    expect(failures).toContain(
      "staging PITR evidence does not match the verified workflow run URL",
    );
    expect(failures).toContain(
      "staging PITR user-data undo does not restore the pre-restore bookmark",
    );
    expect(failures).toContain(
      "staging PITR user-data evidence is not within the allowed TTL",
    );
    expect(failures).toContain(
      "staging PITR evidence must contain exactly one identity-directory result",
    );
  });

  it("rejects local evidence paths and requires a numeric protected run ID", () => {
    expect(() =>
      requiredPitrEvidenceRunId({
        PITR_EVIDENCE_PATH: ".artifacts/pitr/staging.json",
        PITR_EVIDENCE_RUN_ID: "123",
      }),
    ).toThrow("PITR_EVIDENCE_PATH is not trusted");
    expect(() =>
      requiredPitrEvidenceRunId({ PITR_EVIDENCE_RUN_ID: "../123" }),
    ).toThrow("PITR_EVIDENCE_RUN_ID must identify");
    expect(
      requiredPitrEvidenceRunId({ PITR_EVIDENCE_RUN_ID: "123456789" }),
    ).toBe(123456789);
  });

  it("requires an approved main workflow run and its exact GitHub artifact", () => {
    const headSha = "a".repeat(40);
    const runId = 123456789;
    const run = {
      id: runId,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: headSha,
      path: ".github/workflows/staging-pitr-smoke.yml@refs/heads/main",
      html_url: `https://github.com/tuanemuy/fog/actions/runs/${runId}`,
      repository: { full_name: "tuanemuy/fog" },
    };
    const artifact = {
      id: 987654321,
      name: `staging-pitr-${headSha}`,
      expired: false,
      digest: `sha256:${"b".repeat(64)}`,
      workflow_run: { id: runId, head_sha: headSha },
    };
    const environment = {
      id: 42,
      name: "staging-pitr",
      protection_rules: [
        {
          type: "required_reviewers",
          reviewers: [
            {
              type: "User",
              reviewer: { id: 7, login: "release-owner" },
            },
          ],
        },
        { type: "branch_policy" },
      ],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    };
    const branchPolicies = {
      branch_policies: [{ name: "main", type: "branch" }],
    };
    const approvals = [
      {
        state: "approved",
        environments: [{ id: 42, name: "staging-pitr" }],
        user: { id: 7, login: "release-owner" },
      },
    ];
    const context = { repository: "tuanemuy/fog", runId, headSha };

    expect(
      validatePitrGithubProvenance(
        {
          run,
          artifactList: { artifacts: [artifact] },
          environment,
          branchPolicies,
          approvals,
        },
        context,
      ),
    ).toEqual([]);

    expect(
      validatePitrGithubProvenance(
        {
          run: {
            ...run,
            event: "push",
            conclusion: "failure",
            repository: { full_name: "attacker/fog" },
          },
          artifactList: {
            artifacts: [{ ...artifact, digest: null, expired: true }],
          },
          environment: {
            ...environment,
            protection_rules: [],
          },
          branchPolicies: { branch_policies: [] },
          approvals: [],
        },
        context,
      ),
    ).toEqual(
      expect.arrayContaining([
        "PITR workflow run belongs to another repository",
        "PITR workflow run was not manually dispatched",
        "PITR workflow run did not complete successfully",
        "staging-pitr environment has no required reviewer",
        "PITR workflow run has no staging-pitr approval from a required reviewer",
        "staging-pitr environment does not allow only main releases",
        "PITR workflow artifact is expired",
        "PITR workflow artifact has no valid SHA-256 digest",
      ]),
    );
  });

  it("verifies the downloaded artifact archive against GitHub's digest", () => {
    const archive = new TextEncoder().encode("immutable artifact bytes");
    expect(
      verifyGithubArtifactDigest(
        archive,
        "sha256:4e5dd5cddfe6ca669736dac91231b75e7b7e7949f5152e9aaeb810cd2ede2076",
      ),
    ).toBe(true);
    expect(
      verifyGithubArtifactDigest(archive, `sha256:${"0".repeat(64)}`),
    ).toBe(false);
  });
});
