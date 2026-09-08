import { describe, expect, it } from "vitest";
import { approveAiClientAuthorization } from "../approveAiClientAuthorization";
import { authorizeAiClient } from "../authorizeAiClient";
import { consumeAuthorizationCode } from "../consumeAuthorizationCode";
import { listAiClientConnections } from "../listAiClientConnections";
import { revokeAiClientConnection } from "../revokeAiClientConnection";
import { revokeAllAiClientConnections } from "../revokeAllAiClientConnections";
import {
  type GatewayCall,
  makeContainer,
  recordingGateway,
} from "./unitContainer";

// The request side of each identity usecase is a straight hand-off to the
// gateway; what these pin is the arguments' shape and that nothing else is
// reached (the procedures are covered by the integration suite).
describe("AI client connection usecases (request side)", () => {
  it("approve hands the client name through and returns the id", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      approveAiClientAuthorization: async () => ({ connectionId: "c1" }),
    });
    expect(
      await approveAiClientAuthorization({
        container: makeContainer(gateway),
        input: { userId: "u", clientName: "Claude" },
      }),
    ).toEqual({ connectionId: "c1" });
    expect(calls).toEqual([
      {
        name: "approveAiClientAuthorization",
        args: ["u", { clientName: "Claude" }],
      },
    ]);
  });

  it("list, revoke, revokeAll, authorize and consume address the user's own object", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      listAiClientConnections: async () => ({ connections: [] }),
      revokeAiClientConnection: async () => undefined,
      revokeAllAiClientConnections: async () => ({
        revokedCount: 2,
        failedCount: 1,
      }),
      authorizeAiClient: async () => null,
      consumeAuthorizationCode: async () => ({ ok: false }),
    });
    const container = makeContainer(gateway);
    const expiresAt = new Date("2026-09-08T00:10:00.000Z");
    expect(
      await listAiClientConnections({ container, input: { userId: "u" } }),
    ).toEqual({
      connections: [],
    });
    await revokeAiClientConnection({
      container,
      input: { userId: "u", connectionId: "c" },
    });
    expect(
      await revokeAllAiClientConnections({ container, input: { userId: "u" } }),
    ).toEqual({
      revokedCount: 2,
      failedCount: 1,
    });
    expect(
      await authorizeAiClient({
        container,
        input: { userId: "u", connectionId: "c" },
      }),
    ).toBeNull();
    expect(
      await consumeAuthorizationCode({
        container,
        input: { userId: "u", jti: "j", expiresAt, connectionId: "c" },
      }),
    ).toEqual({ ok: false });
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ["listAiClientConnections", ["u"]],
      ["revokeAiClientConnection", ["u", "c"]],
      ["revokeAllAiClientConnections", ["u"]],
      ["authorizeAiClient", ["u", "c"]],
      [
        "consumeAuthorizationCode",
        ["u", { jti: "j", expiresAt, connectionId: "c" }],
      ],
    ]);
  });
});
