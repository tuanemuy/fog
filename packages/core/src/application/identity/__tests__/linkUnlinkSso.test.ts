import type { MappingLocator } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { describe, expect, it } from "vitest";
import { ConflictError, isConflictError } from "../../errors";
import type { BeginLinkDto, CompleteLinkDto } from "../gateway";
import { linkSsoCredential } from "../linkSsoCredential";
import { unlinkSsoCredential } from "../unlinkSsoCredential";
import {
  expectCode,
  type GatewayCall,
  makeContainer,
  recordingGateway,
} from "./unitContainer";

const LOCATOR: MappingLocator = {
  credentialId: "ffffffff-ffff-7fff-8fff-000000000001",
  kind: "sso",
  hmac: "h".repeat(64),
  generation: 1,
  bucketIndex: 2,
};

describe("linkSsoCredential", () => {
  it("records first, reserves, activates, then completes with the provider as label", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      deriveCredentialLocator: async () => LOCATOR,
      beginLink: async () => ({ callerToken: "t".repeat(32) }),
      reserveCredential: async () => undefined,
      activateReservation: async () => true,
      completeLink: async () => undefined,
    });
    const result = await linkSsoCredential({
      container: makeContainer(gateway),
      input: { userId: "user-1", provider: "google", providerSubject: " abc " },
    });
    expect(result.credentialId).toBe(LOCATOR.credentialId);
    expect(calls.map((c) => c.name)).toEqual([
      "deriveCredentialLocator",
      "beginLink",
      "reserveCredential",
      "activateReservation",
      "completeLink",
    ]);
    const begin = calls[1]?.args[1] as BeginLinkDto;
    expect(begin.label).toBe("google");
    expect(calls[2]?.args[1]).toMatchObject({
      candidateUserId: "user-1",
      callerToken: "t".repeat(32),
      canonical: "google\u0000abc",
      passwordVerifier: null,
    });
    const complete = calls[4]?.args[1] as CompleteLinkDto;
    expect(complete.locator).toMatchObject({
      kind: "sso",
      usableForLogin: true,
      label: "google",
      credentialVersion: 1,
      mapping: `g1:b2:${LOCATOR.hmac}`,
    });
  });

  it("closes the record and reports SSO_IDENTITY_ALREADY_REGISTERED when the reservation is lost", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      deriveCredentialLocator: async () => LOCATOR,
      beginLink: async () => ({ callerToken: "t".repeat(32) }),
      reserveCredential: async () => {
        throw new ConflictError("EMAIL_ALREADY_REGISTERED", "held");
      },
      finishLink: async () => undefined,
    });
    await expectCode(
      linkSsoCredential({
        container: makeContainer(gateway),
        input: { userId: "user-1", provider: "google", providerSubject: "abc" },
      }),
      isConflictError,
      "SSO_IDENTITY_ALREADY_REGISTERED",
    );
    expect(calls.map((c) => c.name).slice(-1)).toEqual(["finishLink"]);
  });
});

describe("unlinkSsoCredential", () => {
  it("lets the User Data side decide, then deletes every generation's row and closes the record", async () => {
    const calls: GatewayCall[] = [];
    const gateway = recordingGateway(calls, {
      beginUnlink: async () => ({
        callerToken: "t".repeat(32),
        locators: [
          {
            credentialId: "c",
            kind: "sso",
            mapping: "g2:b1:x",
            credentialVersion: 1,
            usableForLogin: true,
            label: "google",
          },
          {
            credentialId: "c",
            kind: "sso",
            mapping: "g1:b4:y",
            credentialVersion: 1,
            usableForLogin: true,
            label: "google",
          },
        ],
      }),
      deleteMapping: async () => ({ deleted: true, generation: 1 }),
      finishUnlink: async () => undefined,
    });
    await unlinkSsoCredential({
      container: makeContainer(gateway),
      input: { userId: "user-1", credentialId: "c" },
    });
    expect(calls.map((c) => c.name)).toEqual([
      "beginUnlink",
      "deleteMapping",
      "deleteMapping",
      "finishUnlink",
    ]);
    expect(calls[1]?.args).toEqual([
      { credentialId: "c", kind: "sso", mapping: "g2:b1:x" },
      { userId: "user-1", callerToken: "t".repeat(32) },
    ]);
  });
});
