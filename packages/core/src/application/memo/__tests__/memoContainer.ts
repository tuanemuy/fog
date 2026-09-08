import { createIdentityTuning } from "@repo/core/application/identity/tuning";
import type { UsecaseContainer } from "@repo/core/application/types";
import {
  FakeIdGenerator,
  FakeLogger,
  FakePasswordHasher,
  FakeTokenGenerator,
  trippingIdentityGateway,
  trippingKnowledgeGateway,
  trippingMemoGateway,
} from "../../__tests__/fakes";
import type { MemoGateway } from "../gateway";

export const NOW = new Date("2026-09-08T00:00:00.000Z");

/**
 * A container whose gateways all trip, except the memo entries a suite
 * overrides. It is what lets the request-side tests assert exactly which
 * gateway call a usecase makes and with which primitives.
 */
export function memoContainer(
  overrides: Partial<MemoGateway>,
): UsecaseContainer {
  return {
    clock: { now: () => NOW },
    idGenerator: new FakeIdGenerator(),
    tokenGenerator: new FakeTokenGenerator(),
    logger: new FakeLogger(),
    config: {
      appUrl: "http://localhost",
      siteName: "fog",
      defaultTitle: "fog",
      defaultDescription: "",
      themeColor: "#000",
    },
    identityGateway: trippingIdentityGateway((name) => {
      throw new Error(`unexpected identity gateway call: ${name}`);
    }),
    identityTuning: createIdentityTuning(),
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`unexpected memo gateway call: ${name}`);
    }, overrides),
    knowledgeGateway: trippingKnowledgeGateway((name) => {
      throw new Error(`unexpected knowledge gateway call: ${name}`);
    }),
    passwordHasher: new FakePasswordHasher(),
  };
}

export const EMPTY_WINDOW = {
  items: [],
  pivotId: null,
  olderCursor: null,
  newerCursor: null,
} as const;
