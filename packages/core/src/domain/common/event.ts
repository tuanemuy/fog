import { BusinessRuleError } from "@repo/core/domain/error";

declare const eventIdBrand: unique symbol;

export type EventId = string & { readonly [eventIdBrand]: true };

// As with `UserId`, the domain treats event ids as opaque, non-empty
// strings and normalises them by trimming. Format (UUIDv7 in this
// template) is the `IdGenerator`'s responsibility.
//
// Its limit: minting is the only point of validation, and the ids the
// relay's claim and `list-quarantined-events` read back out of a DO's own
// tables stay raw strings — those rows never left the object that wrote
// them, so nothing about them crossed a transport boundary.
//
// The `eventId` the send-materials RPC takes did cross one — it rode a
// Queue message out and came back as an RPC argument — and is not rebuilt
// either, because non-emptiness is the only invariant `EventId` carries
// and the guard subsumes it: an empty argument is rejected ahead of the
// row lookup and a blank one matches no row, both answering
// `nothing-to-send`.
export const EventId = {
  create: (id: string): EventId => {
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError("INVALID_EVENT_ID", "Invalid event id");
    }
    return trimmed as EventId;
  },
};

/**
 * The identity-less shape produced by the domain.
 *
 * `EventId` is minted by the unit-of-work implementation against the
 * application's `IdGenerator` port, so the domain touches neither id
 * generation nor a clock — `occurredAt` is handed in by the caller.
 *
 * The single write path into `outbox_events` is the unit-of-work
 * context's `enqueueEvent`, which takes drafts and writes the row inside
 * the same `transactionSync` as the business data. There is no other
 * registration point (`spec/database/index.md`, `spec/async/index.md`).
 *
 * `payload` carries neither PII nor a reusable secret — it is persisted
 * for the PITR retention window and is copied verbatim into the Queue
 * message (`spec/async/index.md`, hygiene rules).
 */
export type DomainEventDraftBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  aggregateId: string;
}>;

export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = DomainEventDraftBase<TType, TPayload> & Readonly<{ id: EventId }>;

export type DomainEvent = DomainEventBase;

// Identity-less event shape returned by domain functions.
//
// The conditional is what makes this **distributive** over event unions:
// `EventDraft<AEvent | BEvent>` expands to
// `Omit<AEvent, "id"> | Omit<BEvent, "id">` rather than collapsing to a
// single shape — which is what preserves the `type` discriminator and
// lets consumers narrow on `draft.type`.
export type EventDraft<TEvent extends DomainEvent = DomainEvent> =
  TEvent extends unknown ? Omit<TEvent, "id"> : never;

/**
 * Pairing of the entity a transition produced with the event drafts it
 * emitted. The usecase hands `eventDrafts` to `enqueueEvent` inside the
 * same unit of work that persists `entity`.
 *
 * No concrete event type is defined today: the enumerated roster in
 * `spec/async/index.md` declares zero User Data DO event types, and the
 * one Identity Directory event (`identity.passwordResetRequested`) is
 * emitted by a draft factory rather than an aggregate transition.
 */
export type WithEventDrafts<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  eventDrafts: readonly EventDraft<TEvent>[];
}>;
