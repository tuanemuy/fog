import { describe, expect, it } from "vitest";
import { handlePitrOperatorRequest, type PitrOperatorEnv } from "../pitr";

const token = "operator-token-with-at-least-thirty-two-bytes";

function request(body: unknown): Request {
  return new Request("https://fog.test/_operator/pitr", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("PITR operator HTTP boundary", () => {
  it("rejects Account Home before any Durable Object RPC", async () => {
    let calls = 0;
    const namespace = {
      getByName() {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    const response = await handlePitrOperatorRequest(
      request({
        action: "restore",
        className: "AccountHomeDurableObject",
        objectName: "opaque-object",
        accountId: "opaque-account",
        bookmark: "bookmark",
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        USER_DATA: namespace,
        IDENTITY_DIRECTORY: namespace,
        ACCOUNT_HOME: namespace,
      } as unknown as PitrOperatorEnv,
    );
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "ACCOUNT_HOME_RESTORE_FORBIDDEN",
    });
    expect(calls).toBe(0);
  });

  it("does not reveal whether operator input is valid without authentication", async () => {
    const response = await handlePitrOperatorRequest(
      new Request("https://fog.test/_operator/pitr", {
        method: "POST",
        body: "{}",
      }),
      {
        PITR_OPERATOR_TOKEN: token,
      } as PitrOperatorEnv,
    );
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "UNAUTHORIZED" });
  });
});
