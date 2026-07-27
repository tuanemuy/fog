import { describe, expect, it, vi } from "vitest";
import {
  handleIdentityMaintenanceRequest,
  type IdentityMaintenanceEnv,
} from "../identity-maintenance";

const token = "operator-token-with-at-least-thirty-two-bytes";

function request(body: unknown): Request {
  return new Request("https://fog.test/_operator/identity-maintenance", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("identity maintenance operator", () => {
  it("executes exactly one checkpoint-backed rotation page per request", async () => {
    const rotatePage = vi.fn(async () => ({
      scanned: 100,
      moved: 99,
      conflicts: 1,
      nextCursor: "next",
      completed: false,
    }));
    const response = await handleIdentityMaintenanceRequest(
      request({
        action: "rotate-page",
        generation: "previous-v1",
        bucket: 7,
        limit: 100,
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        DIRECTORY_ROUTING_GENERATION_PREVIOUS: "previous-v1",
        DIRECTORY_ROUTING_SECRET_PREVIOUS:
          "previous-routing-secret-with-at-least-32-bytes",
      } as IdentityMaintenanceEnv,
      () => ({
        rotatePage,
        reconcilePage: vi.fn(),
        status: vi.fn(),
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(rotatePage).toHaveBeenCalledOnce();
    expect(rotatePage).toHaveBeenCalledWith({
      generation: "previous-v1",
      bucket: 7,
      limit: 100,
    });
    expect(await response?.json()).toMatchObject({
      nextCursor: "next",
      completed: false,
    });
  });

  it("bounds maintenance pages before invoking the gateway", async () => {
    const response = await handleIdentityMaintenanceRequest(
      request({
        action: "reconcile-page",
        generation: "active-v2",
        bucket: 0,
        limit: 101,
      }),
      {
        PITR_OPERATOR_TOKEN: token,
        DIRECTORY_ROUTING_GENERATION_ACTIVE: "active-v2",
      } as IdentityMaintenanceEnv,
      () => {
        throw new Error("must not construct gateway");
      },
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "INVALID_OPERATOR_INPUT",
    });
  });

  it.each([
    ["unknown generation", "unknown-v9", 0],
    ["negative bucket", "active-v2", -1],
    ["bucket upper bound", "active-v2", 64],
    ["huge bucket", "active-v2", Number.MAX_SAFE_INTEGER],
  ])(
    "rejects %s before constructing the gateway",
    async (_label, generation, bucket) => {
      const create = vi.fn(() => {
        throw new Error("must not construct gateway");
      });
      const response = await handleIdentityMaintenanceRequest(
        request({
          action: "status",
          generation,
          bucket,
        }),
        {
          PITR_OPERATOR_TOKEN: token,
          DIRECTORY_ROUTING_GENERATION_ACTIVE: "active-v2",
          DIRECTORY_ROUTING_GENERATION_PREVIOUS: "previous-v1",
        } as IdentityMaintenanceEnv,
        create,
      );
      expect(response?.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    },
  );
});
