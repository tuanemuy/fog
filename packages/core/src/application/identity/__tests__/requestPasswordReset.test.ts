import type { EventDraft } from "@repo/core/domain/common/event";
import type { PasswordResetRequestedEvent } from "@repo/core/domain/identity/passwordResetRequested";
import type {
  CredentialMappingReader,
  CredentialMappingRecord,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { PasswordResetTokenPort } from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import { CredentialId, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import type {
  EnqueueJobInput,
  IdentityDirectoryUnitOfWorkContext,
} from "../../execution/unitOfWork";
import {
  requestPasswordResetProcedure,
  windowEndOf,
  windowKeyOf,
} from "../requestPasswordReset";
import { NOW, TUNING } from "./unitContainer";

type Recorded = {
  events: EventDraft<PasswordResetRequestedEvent>[];
  jobs: EnqueueJobInput<string>[];
  issued: string[];
  decoys: number;
};

function record(
  overrides: Partial<CredentialMappingRecord> | null,
  claim: boolean,
): { ctx: IdentityDirectoryUnitOfWorkContext; recorded: Recorded } {
  const recorded: Recorded = { events: [], jobs: [], issued: [], decoys: 0 };
  const row: CredentialMappingRecord | null =
    overrides === null
      ? null
      : ({
          credentialId: CredentialId.create("cred-1"),
          kind: "email",
          status: "active",
          userId: UserId.create("user-1"),
          credentialVersion: 1,
          changeState: null,
          changeOrigin: null,
          failedAttempts: 0,
          nextAttemptAllowedAt: null,
          passwordVerifier: "fake$verifier",
          sealedCanonical: {
            ciphertext: "",
            encryptionGeneration: 1,
            nonce: "",
          },
          ...overrides,
        } as CredentialMappingRecord);
  const reader: CredentialMappingReader = {
    findByLocator: () => row,
    findByCredentialId: () => row,
  };
  const tokens: PasswordResetTokenPort = {
    issue: (credentialId) => {
      recorded.issued.push(credentialId);
      return { token: "1.0.secret", tokenId: "real-token-id" };
    },
    mintDecoyTokenId: () => {
      recorded.decoys += 1;
      return "decoy-token-id";
    },
    verifyAndConsume: () => null,
  };
  const ctx = {
    credentialMappingReader: reader,
    resetTokenStore: tokens,
    resetThrottleStore: { claimWindow: () => claim },
    enqueueEvent: (
      drafts: readonly EventDraft<PasswordResetRequestedEvent>[],
    ) => {
      recorded.events.push(...drafts);
    },
    enqueueJob: (input: EnqueueJobInput<string>) => {
      recorded.jobs.push(input);
    },
  } as unknown as IdentityDirectoryUnitOfWorkContext;
  return { ctx, recorded };
}

const INPUT = { hmac: "a".repeat(64), mapping: "g1:b0:aaaa" };

describe("windowKeyOf / windowEndOf", () => {
  it("joins the HMAC and the window index, and ends at the next window boundary", () => {
    const windowMs = TUNING.resetRequestWindowMs;
    const index = Math.floor(NOW.getTime() / windowMs);
    expect(windowKeyOf("h", NOW.getTime(), windowMs)).toBe(`h:${index}`);
    expect(windowEndOf(NOW.getTime(), windowMs).getTime()).toBe(
      (index + 1) * windowMs,
    );
  });
});

describe("requestPasswordResetProcedure", () => {
  it("the first request in a window for a credential with a verifier issues a token and writes one event", () => {
    const { ctx, recorded } = record({}, true);
    requestPasswordResetProcedure(ctx, INPUT, NOW, TUNING);
    expect(recorded.issued).toEqual(["cred-1"]);
    expect(recorded.decoys).toBe(0);
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]?.payload).toEqual({
      tokenId: "real-token-id",
      mailKind: "password-reset",
    });
    expect(recorded.events[0]?.aggregateId).toBe(
      windowKeyOf(INPUT.hmac, NOW.getTime(), TUNING.resetRequestWindowMs),
    );
  });

  it.each([
    ["an unknown address", null],
    ["an SSO-only account's address", { passwordVerifier: null }],
    ["a reservation not yet activated", { userId: null }],
  ] as const)(
    "the first request for %s writes the same one event with a decoy id and issues nothing",
    (_label, overrides) => {
      const { ctx, recorded } = record(overrides, true);
      requestPasswordResetProcedure(ctx, INPUT, NOW, TUNING);
      expect(recorded.issued).toEqual([]);
      expect(recorded.decoys).toBe(1);
      expect(recorded.events).toHaveLength(1);
      expect(recorded.events[0]?.payload).toEqual({
        tokenId: "decoy-token-id",
        mailKind: "password-reset",
      });
    },
  );

  it("a later request in the same window writes no event and issues nothing, whatever the credential", () => {
    for (const overrides of [{}, null, { passwordVerifier: null }]) {
      const { ctx, recorded } = record(overrides, false);
      requestPasswordResetProcedure(ctx, INPUT, NOW, TUNING);
      expect(recorded.events).toEqual([]);
      expect(recorded.issued).toEqual([]);
      expect(recorded.decoys).toBe(0);
    }
  });

  it("always enqueues the sweep for the window's end", () => {
    for (const claim of [true, false]) {
      const { ctx, recorded } = record({}, claim);
      requestPasswordResetProcedure(ctx, INPUT, NOW, TUNING);
      expect(recorded.jobs).toEqual([
        {
          operationKey: "sweep-reset-tokens",
          kind: "sweep-reset-tokens",
          payload: {},
          nextRunAt: windowEndOf(NOW.getTime(), TUNING.resetRequestWindowMs),
        },
      ]);
    }
  });
});
