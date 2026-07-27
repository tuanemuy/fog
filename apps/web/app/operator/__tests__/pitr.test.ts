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
                    userDataObjectName: "canonical-user-data",
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
          shard: "active-v1:7",
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
      version: 1,
      target: { kind: "identity-directory", shard: "active-v1:7" },
      restoreBookmark: "bookmark-before-mutation",
      undoBookmark: "undo-bookmark",
      reconcileCursor: null,
    });
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
