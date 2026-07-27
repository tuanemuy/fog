import { describe, expect, it } from "vitest";
import {
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
    expect(
      validatePitrReleaseEvidence(
        [
          {
            name: "staging PITR bookmark/restore/verify/undo",
            result: "passed",
            stage: "staging",
            namespace: "fog-staging-pitr-disposable",
            verifiedAt: "2026-07-27T00:00:00Z",
            expiresAt: "2026-08-03T00:00:00Z",
          },
        ],
        now,
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
        now,
      ),
    ).toEqual([
      "staging PITR release evidence is pending",
      "staging PITR evidence must identify the disposable namespace",
      "staging PITR evidence has no valid verifiedAt",
      "staging PITR evidence is expired or has no valid expiresAt",
    ]);
  });
});
