import { isSystemError } from "@repo/core/application/errors";
import { EventId } from "@repo/core/domain/common/event";
import { IdentityEvents } from "@repo/core/domain/identity/events";
import {
  TrashRetentionDays,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { identityEventDecoders } from "../eventDecoders";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const USER_ID = UserId.create("01950000-0000-7000-8000-000000000001");
const EVENT_ID = EventId.create("01950000-0000-7000-8000-0000000000ff");

const meta = { id: EVENT_ID, occurredAt: NOW, aggregateId: USER_ID };

// The outbox stores the payload as JSON, so a round trip through
// `JSON.stringify` is what the decoder actually receives at runtime.
const atRest = (payload: unknown): unknown =>
  JSON.parse(JSON.stringify(payload));

describe("identityEventDecoders", () => {
  it("round-trips identity.userRegistered", () => {
    const draft = IdentityEvents.userRegistered(USER_ID, "password", NOW);
    const decoded = identityEventDecoders["identity.userRegistered"](
      atRest(draft.payload),
      meta,
    );

    expect(decoded).toEqual({ ...draft, id: EVENT_ID });
  });

  it("round-trips identity.passwordChanged", () => {
    const draft = IdentityEvents.passwordChanged(USER_ID, NOW);
    const decoded = identityEventDecoders["identity.passwordChanged"](
      atRest(draft.payload),
      meta,
    );

    expect(decoded).toEqual({ ...draft, id: EVENT_ID });
  });

  it("round-trips identity.trashRetentionChanged", () => {
    const draft = IdentityEvents.trashRetentionChanged(
      USER_ID,
      TrashRetentionDays.create(7),
      NOW,
    );
    const decoded = identityEventDecoders["identity.trashRetentionChanged"](
      atRest(draft.payload),
      meta,
    );

    expect(decoded).toEqual({ ...draft, id: EVENT_ID });
  });

  it("takes id / occurredAt / aggregateId from the row, not the payload", () => {
    const other = new Date("2020-05-05T00:00:00.000Z");
    const decoded = identityEventDecoders["identity.passwordChanged"](
      { userId: USER_ID, occurredAt: NOW, aggregateId: "ignored" },
      { id: EVENT_ID, occurredAt: other, aggregateId: "row-aggregate" },
    );

    expect(decoded.occurredAt).toBe(other);
    expect(decoded.aggregateId).toBe("row-aggregate");
  });

  it.each([
    ["missing userId", "identity.userRegistered", { authMethod: "password" }],
    [
      "unknown authMethod",
      "identity.userRegistered",
      { userId: USER_ID, authMethod: "magic-link" },
    ],
    ["not an object", "identity.passwordChanged", "just-a-string"],
    ["null payload", "identity.passwordChanged", null],
    [
      "retentionDays as a string",
      "identity.trashRetentionChanged",
      { userId: USER_ID, retentionDays: "7" },
    ],
  ] as const)(
    "raises SystemError(DATA_INTEGRITY_ERROR) on a schema mismatch: %s",
    (_label, type, payload) => {
      let caught: unknown;
      try {
        identityEventDecoders[type](payload, meta);
      } catch (error) {
        caught = error;
      }

      expect(isSystemError(caught)).toBe(true);
      expect(isSystemError(caught) && caught.code).toBe("DATA_INTEGRITY_ERROR");
    },
  );

  it("lets a value-object violation in a shape-valid payload surface", () => {
    expect(() =>
      identityEventDecoders["identity.trashRetentionChanged"](
        { userId: USER_ID, retentionDays: 0 },
        meta,
      ),
    ).toThrow();
  });
});
