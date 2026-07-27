import { describe, expect, it } from "vitest";
import { handlePitrOperatorRequest, type PitrOperatorEnv } from "../pitr";

const token = "operator-token-with-at-least-thirty-two-bytes";

function request(body: unknown, authenticated = true): Request {
  return new Request("https://fog.test/_operator/pitr", {
    method: "POST",
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("PITR operator HTTP boundary", () => {
  it("derives the User Data object from Account Home instead of accepting objectName", async () => {
    const selected: string[] = [];
    const userData = {
      getByName(name: string) {
        selected.push(name);
        return {
          async operatorGetCurrentBookmark() {
            return "bookmark";
          },
        };
      },
    };
    const response = await handlePitrOperatorRequest(
      request({
        action: "bookmark",
        target: { kind: "user-data", accountId: "account-1" },
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        USER_DATA: userData,
        ACCOUNT_HOME: {
          getByName() {
            return {
              async getAuthSummary() {
                return {
                  ok: true,
                  value: {
                    userId: "canonical-user-data",
                    status: "active",
                    operationEpoch: 3,
                  },
                };
              },
            };
          },
        },
      } as unknown as PitrOperatorEnv,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ bookmark: "bookmark" });
    expect(selected).toEqual(["canonical-user-data"]);
  });

  it("rejects caller-controlled User Data object names", async () => {
    const response = await handlePitrOperatorRequest(
      request({
        action: "bookmark",
        target: {
          kind: "user-data",
          accountId: "account-1",
          objectName: "different-object",
        },
      }),
      { PITR_OPERATOR_TOKEN: token } as PitrOperatorEnv,
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "INVALID_OPERATOR_INPUT",
    });
  });

  it("schedules an isolated Directory shard without a single-account authority shortcut", async () => {
    const response = await handlePitrOperatorRequest(
      request({
        action: "schedule",
        target: {
          kind: "identity-directory",
          generation: "active-v1",
          bucket: 7,
        },
        bookmark: "bookmark-before-mutation",
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        DIRECTORY_ROUTING_SECRET_ACTIVE:
          "directory-routing-secret-with-at-least-32-bytes",
        DIRECTORY_ROUTING_GENERATION_ACTIVE: "active-v1",
        IDENTITY_DIRECTORY: {
          getByName(name: string) {
            expect(name).toBe("active-v1:7");
            return {
              async operatorPrepareRestoreProof() {
                return { sessionId: "session-before-restore" };
              },
              async operatorRestoreBookmark(bookmark: string) {
                expect(bookmark).toBe("bookmark-before-mutation");
                return "undo-bookmark";
              },
            };
          },
        },
        ACCOUNT_HOME: {
          getByName() {
            throw new Error("Directory schedule must not select one account");
          },
        },
        USER_DATA: {},
      } as unknown as PitrOperatorEnv,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      version: 2,
      target: {
        kind: "identity-directory",
        generation: "active-v1",
        bucket: 7,
      },
      restoreBookmark: "bookmark-before-mutation",
      undoBookmark: "undo-bookmark",
      proof: {
        previousSessionId: "session-before-restore",
        undoBookmark: "undo-bookmark",
      },
      reconcileCursor: null,
    });
  });

  it.each([
    ["unknown generation", "unknown-v9", 0, 409],
    ["negative bucket", "active-v1", -1, 400],
    ["bucket upper bound", "active-v1", 64, 400],
    ["huge bucket", "active-v1", Number.MAX_SAFE_INTEGER, 400],
  ])(
    "rejects %s before selecting a Directory object",
    async (_label, generation, bucket, status) => {
      let selected = false;
      const response = await handlePitrOperatorRequest(
        request({
          action: "bookmark",
          target: { kind: "identity-directory", generation, bucket },
        }),
        {
          PITR_OPERATOR_TOKEN: token,
          DIRECTORY_ROUTING_SECRET_ACTIVE:
            "directory-routing-secret-with-at-least-32-bytes",
          DIRECTORY_ROUTING_GENERATION_ACTIVE: "active-v1",
          IDENTITY_DIRECTORY: {
            getByName() {
              selected = true;
              throw new Error("must not select a Directory object");
            },
          },
        } as unknown as PitrOperatorEnv,
      );
      expect(response?.status).toBe(status);
      expect(selected).toBe(false);
    },
  );

  it("rejects a restart failure that is not the expected session abort", async () => {
    const response = await handlePitrOperatorRequest(
      request({
        action: "restart",
        receipt: {
          version: 2,
          target: {
            kind: "identity-directory",
            generation: "active-v1",
            bucket: 7,
          },
          restoreBookmark: "old",
          undoBookmark: "undo",
          proof: {
            id: "proof",
            previousSessionId: "previous-session",
            undoBookmark: "undo",
          },
          reconcileCursor: null,
          reconciliationTotals: {
            scanned: 0,
            tombstoned: 0,
            conflictsObserved: 0,
          },
        },
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        DIRECTORY_ROUTING_SECRET_ACTIVE:
          "directory-routing-secret-with-at-least-32-bytes",
        DIRECTORY_ROUTING_GENERATION_ACTIVE: "active-v1",
        IDENTITY_DIRECTORY: {
          getByName() {
            return {
              async operatorRestartSession() {
                throw new Error("binding unavailable");
              },
            };
          },
        },
      } as unknown as PitrOperatorEnv,
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ error: "binding unavailable" });
  });

  it("accepts only the expected Durable Object restart abort", async () => {
    const response = await handlePitrOperatorRequest(
      request({
        action: "restart",
        receipt: {
          version: 2,
          target: {
            kind: "identity-directory",
            generation: "active-v1",
            bucket: 7,
          },
          restoreBookmark: "old",
          undoBookmark: "undo",
          proof: {
            id: "proof",
            previousSessionId: "previous-session",
            undoBookmark: "undo",
          },
          reconcileCursor: null,
          reconciliationTotals: {
            scanned: 0,
            tombstoned: 0,
            conflictsObserved: 0,
          },
        },
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        DIRECTORY_ROUTING_SECRET_ACTIVE:
          "directory-routing-secret-with-at-least-32-bytes",
        DIRECTORY_ROUTING_GENERATION_ACTIVE: "active-v1",
        IDENTITY_DIRECTORY: {
          getByName() {
            return {
              async operatorRestartSession() {
                throw new Error("PITR_RESTART_REQUESTED");
              },
            };
          },
        },
      } as unknown as PitrOperatorEnv,
    );
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ phase: "restart-requested" });
  });

  it("does not reveal input validity without authentication and disables caching", async () => {
    const response = await handlePitrOperatorRequest(request({}, false), {
      PITR_OPERATOR_TOKEN: token,
    } as PitrOperatorEnv);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({ error: "UNAUTHORIZED" });
  });
});
