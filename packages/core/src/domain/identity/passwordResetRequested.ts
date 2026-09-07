import type {
  DomainEventBase,
  EventDraft,
} from "@repo/core/domain/common/event";

export const PASSWORD_RESET_REQUESTED = "identity.passwordResetRequested";

export type MailKind = "password-reset";

/**
 * The only event type in the system. Emitted once per throttle window by
 * `requestPasswordReset`, identically for a registered, unregistered, SSO-only
 * or throttled address. The payload carries `tokenId` and the mail kind and
 * nothing else — no address, no raw token, no `userId`, no routing key.
 */
export type PasswordResetRequestedEvent = DomainEventBase<
  typeof PASSWORD_RESET_REQUESTED,
  { tokenId: string; mailKind: MailKind }
>;

/** `aggregateId` is the throttle window key: it exists for every address. */
export function passwordResetRequestedDraft(input: {
  windowKey: string;
  tokenId: string;
  mailKind: MailKind;
  now: Date;
}): EventDraft<PasswordResetRequestedEvent> {
  return {
    type: PASSWORD_RESET_REQUESTED,
    payload: { tokenId: input.tokenId, mailKind: input.mailKind },
    occurredAt: input.now,
    aggregateId: input.windowKey,
  };
}
