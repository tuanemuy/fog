import type { EventDecoder } from "@repo/core/domain/common/event";
import type { IdentityEvent } from "@repo/core/domain/identity/events";
import {
  TrashRetentionDays,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { z } from "zod";
import { buildEventDecoder } from "../events/buildDecoder";

const userRegisteredSchema = z.object({
  userId: z.string(),
  authMethod: z.union([z.literal("password"), z.literal("sso")]),
});
const passwordChangedSchema = z.object({ userId: z.string() });
const trashRetentionChangedSchema = z.object({
  userId: z.string(),
  retentionDays: z.number(),
});

export type IdentityEventDecoders = {
  readonly [K in IdentityEvent["type"]]: EventDecoder<
    Extract<IdentityEvent, { type: K }>
  >;
};

export const identityEventDecoders: IdentityEventDecoders = {
  "identity.userRegistered": buildEventDecoder(
    "identity.userRegistered",
    userRegisteredSchema,
    (p) => ({
      userId: UserId.create(p.userId),
      authMethod: p.authMethod,
    }),
  ),
  "identity.passwordChanged": buildEventDecoder(
    "identity.passwordChanged",
    passwordChangedSchema,
    (p) => ({ userId: UserId.create(p.userId) }),
  ),
  "identity.trashRetentionChanged": buildEventDecoder(
    "identity.trashRetentionChanged",
    trashRetentionChangedSchema,
    (p) => ({
      userId: UserId.create(p.userId),
      retentionDays: TrashRetentionDays.create(p.retentionDays),
    }),
  ),
};
