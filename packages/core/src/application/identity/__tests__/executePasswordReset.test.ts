import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { isValidationError } from "../../errors";
import { executePasswordReset } from "../executePasswordReset";
import type {
  BeginCredentialChangeDto,
  ConsumedResetTokenDto,
} from "../gateway";
import {
  expectCode,
  type GatewayCall,
  makeContainer,
  recordingGateway,
} from "./unitContainer";

const CONSUMED: ConsumedResetTokenDto = {
  userId: "user-1",
  credentialId: "cred-1",
  coordinate: { credentialId: "cred-1", kind: "email", mapping: "g1:b0:h" },
  hasVerifier: true,
  changeAuthToken: "c".repeat(43),
};

describe("executePasswordReset", () => {
  it("checks the new password before spending the token", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      consumeResetToken: async () => CONSUMED,
    });
    await expectCode(
      executePasswordReset({
        container: makeContainer(gateway),
        input: { token: "1.0.secret", newPassword: "short" },
      }),
      isBusinessRuleError,
      "PASSWORD_TOO_WEAK",
    );
    expect(calls).toEqual([]);
  });

  it("answers RESET_TOKEN_INVALID for a token the bucket refuses", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      consumeResetToken: async () => null,
    });
    await expectCode(
      executePasswordReset({
        container: makeContainer(gateway),
        input: { token: "1.0.secret", newPassword: "long-enough-pass" },
      }),
      isValidationError,
      "RESET_TOKEN_INVALID",
    );
  });

  it("refuses a credential without a verifier defensively", async () => {
    const gateway = recordingGateway([], {
      consumeResetToken: async () => ({ ...CONSUMED, hasVerifier: false }),
    });
    await expectCode(
      executePasswordReset({
        container: makeContainer(gateway),
        input: { token: "1.0.secret", newPassword: "long-enough-pass" },
      }),
      isBusinessRuleError,
      "PASSWORD_NOT_SUPPORTED",
    );
  });

  it("runs the credential-change saga with origin reset and the change-auth token", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      consumeResetToken: async () => CONSUMED,
      beginCredentialChange: async () => true,
      applyCredentialChange: async () => ({ credentialVersion: 2 }),
      markCredentialChangeAdvanced: async () => true,
      promoteVerifier: async () => true,
    });
    const result = await executePasswordReset({
      container: makeContainer(gateway),
      input: { token: "1.0.secret", newPassword: "long-enough-pass" },
    });
    expect(result).toEqual({ userId: "user-1" });
    expect(calls.map((c) => c.name)).toEqual([
      "consumeResetToken",
      "beginCredentialChange",
      "applyCredentialChange",
      "markCredentialChangeAdvanced",
      "promoteVerifier",
    ]);
    const begin = calls[1]?.args[1] as BeginCredentialChangeDto;
    expect(begin.origin).toBe("reset");
    expect(begin.changeAuthToken).toBe(CONSUMED.changeAuthToken);
    expect(calls[2]?.args[1]).toEqual({
      credentialId: "cred-1",
      resetCompletion: true,
    });
    expect(calls[4]?.args[1]).toEqual({
      operationId: begin.operationId,
      credentialVersion: 2,
    });
  });
});
