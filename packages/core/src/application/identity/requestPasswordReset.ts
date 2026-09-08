import { passwordResetRequestedDraft } from "@repo/core/domain/identity/passwordResetRequested";
import { Email } from "@repo/core/domain/identity/valueObject";
import type { IdentityDirectoryUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import { SWEEP_RESET_TOKENS_OPERATION_KEY } from "./jobKeys";
import type { IdentityTuning } from "./tuning";

export type RequestPasswordResetInput = Readonly<{ email: string }>;

/** S-AC-07, request side. Every outcome is the same silence. */
export async function requestPasswordReset({
  container,
  input,
}: ServiceArgs<RequestPasswordResetInput>): Promise<void> {
  const email = Email.create(input.email);
  await container.identityGateway.requestPasswordReset(email);
}

export type ResetRequestProcedureInput = Readonly<{
  /** The canonical's full-length HMAC, derived by the stub-selecting adapter. */
  hmac: string;
  /** The mapping the bucket reads the row by (same HMAC, encoded). */
  mapping: string;
}>;

/** `${hmac}:${window index}` — joined, never re-keyed (`spec/database/index.md`, 窓キーの導出). */
export function windowKeyOf(
  hmac: string,
  nowMs: number,
  windowMs: number,
): string {
  return `${hmac}:${Math.floor(nowMs / windowMs)}`;
}

/** The instant the window that contains `nowMs` ends: when its sweep may run. */
export function windowEndOf(nowMs: number, windowMs: number): Date {
  return new Date((Math.floor(nowMs / windowMs) + 1) * windowMs);
}

/**
 * Inside the bucket, one transaction. The window decides everything: its
 * first request writes exactly one event row and issues a token only for
 * a credential that holds a verifier (a decoy id otherwise, from the same
 * generator, so the event row is indistinguishable); a later request in
 * the same window writes nothing. `sweep-reset-tokens` is enqueued on
 * every request for the window's end (`spec/usecases/identity.md`).
 */
export function requestPasswordResetProcedure(
  ctx: IdentityDirectoryUnitOfWorkContext,
  input: ResetRequestProcedureInput,
  now: Date,
  tuning: IdentityTuning,
): void {
  const windowMs = tuning.resetRequestWindowMs;
  const windowKey = windowKeyOf(input.hmac, now.getTime(), windowMs);
  if (ctx.resetThrottleStore.claimWindow(windowKey, now)) {
    const record = ctx.credentialMappingReader.findByLocator(
      "email",
      input.mapping,
    );
    const tokenId =
      record !== null &&
      record.userId !== null &&
      record.passwordVerifier !== null
        ? ctx.resetTokenStore.issue(record.credentialId, now).tokenId
        : ctx.resetTokenStore.mintDecoyTokenId();
    ctx.enqueueEvent([
      passwordResetRequestedDraft({
        windowKey,
        tokenId,
        mailKind: "password-reset",
        now,
      }),
    ]);
  }
  ctx.enqueueJob({
    operationKey: SWEEP_RESET_TOKENS_OPERATION_KEY,
    kind: "sweep-reset-tokens",
    payload: {},
    nextRunAt: windowEndOf(now.getTime(), windowMs),
  });
}
