import { describe, expect, it } from "vitest";
import {
  MAX_PITR_EVIDENCE_TTL_MS,
  validatePitrReleaseEvidence,
  validateSharedStageConfig,
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
        { now, headSha },
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
        { now, headSha },
      ),
    ).toEqual([
      "staging PITR release evidence is pending",
      "staging PITR evidence must identify the disposable namespace",
      "staging PITR evidence does not match the release commit",
      "staging PITR evidence has no valid workflow run URL",
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
      { now, headSha },
    );

    expect(failures).toContain(
      "staging PITR evidence does not match the release commit",
    );
    expect(failures).toContain(
      "staging PITR evidence has no valid workflow run URL",
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
});
