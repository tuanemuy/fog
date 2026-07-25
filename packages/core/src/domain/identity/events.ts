import type {
  DomainEventBase,
  EventDraft,
} from "@repo/core/domain/common/event";
import type { TrashRetentionDays, UserId } from "./valueObject";

export type UserRegisteredEvent = DomainEventBase<
  "identity.userRegistered",
  Readonly<{ userId: UserId; authMethod: "password" | "sso" }>
>;

export type PasswordChangedEvent = DomainEventBase<
  "identity.passwordChanged",
  Readonly<{ userId: UserId }>
>;

export type TrashRetentionChangedEvent = DomainEventBase<
  "identity.trashRetentionChanged",
  Readonly<{ userId: UserId; retentionDays: TrashRetentionDays }>
>;

export type IdentityEvent =
  | UserRegisteredEvent
  | PasswordChangedEvent
  | TrashRetentionChangedEvent;

// Identity-less drafts; `EventId` is attached by the application layer so
// the domain stays free of `IdGenerator`. No payload here ever carries a
// credential — see `PlainPassword` in valueObject.ts.
export const IdentityEvents = {
  userRegistered: (
    userId: UserId,
    authMethod: "password" | "sso",
    occurredAt: Date,
  ): EventDraft<UserRegisteredEvent> => ({
    type: "identity.userRegistered",
    payload: { userId, authMethod },
    occurredAt,
    aggregateId: userId,
  }),

  passwordChanged: (
    userId: UserId,
    occurredAt: Date,
  ): EventDraft<PasswordChangedEvent> => ({
    type: "identity.passwordChanged",
    payload: { userId },
    occurredAt,
    aggregateId: userId,
  }),

  trashRetentionChanged: (
    userId: UserId,
    retentionDays: TrashRetentionDays,
    occurredAt: Date,
  ): EventDraft<TrashRetentionChangedEvent> => ({
    type: "identity.trashRetentionChanged",
    payload: { userId, retentionDays },
    occurredAt,
    aggregateId: userId,
  }),
};
