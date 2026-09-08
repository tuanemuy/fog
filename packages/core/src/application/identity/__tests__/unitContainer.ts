import {
  FakeIdGenerator,
  FakeLogger,
  FakePasswordHasher,
  FakeTokenGenerator,
  trippingIdentityGateway,
  trippingKnowledgeGateway,
  trippingMemoGateway,
  trippingSearchGateway,
  trippingTrashGateway,
} from "../../__tests__/fakes";
import type { UsecaseContainer } from "../../types";
import type { IdentityGateway } from "../gateway";
import { createIdentityTuning } from "../tuning";

export const NOW = new Date("2026-09-08T00:00:00.000Z");
export const TUNING = createIdentityTuning();

export type GatewayCall = Readonly<{
  name: keyof IdentityGateway;
  args: unknown[];
}>;

export function trip(name: keyof IdentityGateway): never {
  throw new Error(`unexpected gateway call: ${name}`);
}

/** A gateway that records every override's call in `calls`, in order, and trips on everything else. */
export function recordingGateway(
  calls: GatewayCall[],
  overrides: Partial<IdentityGateway>,
): IdentityGateway {
  const recorded: Partial<IdentityGateway> = {};
  for (const [name, fn] of Object.entries(overrides) as [
    keyof IdentityGateway,
    (...args: unknown[]) => unknown,
  ][]) {
    (recorded as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return fn(...args);
    };
  }
  return trippingIdentityGateway(trip, recorded);
}

export function makeContainer(
  gateway: IdentityGateway,
  overrides: Partial<UsecaseContainer> = {},
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
      ssoProviders: [],
    },
    identityGateway: gateway,
    identityTuning: TUNING,
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`unexpected memo gateway call: ${name}`);
    }),
    knowledgeGateway: trippingKnowledgeGateway((name) => {
      throw new Error(`unexpected knowledge gateway call: ${name}`);
    }),
    searchGateway: trippingSearchGateway((name) => {
      throw new Error(`unexpected search gateway call: ${name}`);
    }),
    trashGateway: trippingTrashGateway((name) => {
      throw new Error(`unexpected trash gateway call: ${name}`);
    }),
    passwordHasher: new FakePasswordHasher(),
    ...overrides,
  };
}

export async function expectCode<TGuard extends (error: unknown) => boolean>(
  promise: Promise<unknown>,
  guard: TGuard,
  code: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(guard(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

import { expect } from "vitest";
