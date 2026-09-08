import { isValidationError } from "@repo/core/application/errors";
import type { AiClientActorDto } from "@repo/core/application/identity/actorDto";
import { describe, expect, it } from "vitest";
import { trippingMemoGateway } from "../../__tests__/fakes";
import {
  type GatewayCall as IdentityCall,
  makeContainer,
  recordingGateway,
} from "../../identity/__tests__/unitContainer";
import { deleteMemoByAi } from "../deleteMemoByAi";
import type { MemoGateway } from "../gateway";
import { getMemo } from "../getMemo";
import { postMemoByAi } from "../postMemoByAi";
import { recentMemos } from "../recentMemos";
import { updateMemoByAi } from "../updateMemoByAi";

const ACTOR: AiClientActorDto = {
  kind: "aiClient",
  userId: "u",
  connectionId: "c",
  clientName: "Claude",
};
const NOW = new Date("2026-09-08T00:00:00.000Z");

type Call = Readonly<{ name: keyof MemoGateway; args: unknown[] }>;

function memoGateway(
  calls: Call[],
  overrides: Partial<MemoGateway>,
): MemoGateway {
  const recorded: Partial<MemoGateway> = {};
  for (const [name, fn] of Object.entries(overrides) as [
    keyof MemoGateway,
    (...args: unknown[]) => unknown,
  ][]) {
    (recorded as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return fn(...args);
    };
  }
  return trippingMemoGateway((name) => {
    throw new Error(`unexpected memo gateway call: ${name}`);
  }, recorded);
}

function containerWith(gateway: MemoGateway) {
  const identityCalls: IdentityCall[] = [];
  return makeContainer(recordingGateway(identityCalls, {}), {
    memoGateway: gateway,
  });
}

describe("AI memo usecases (request side)", () => {
  it("post_memo posts with the AI actor and projects the three fields", async () => {
    const calls: Call[] = [];
    const gateway = memoGateway(calls, {
      postMemo: async () => ({
        id: "m1",
        body: "hello",
        postedAt: NOW,
        updatedAt: NOW,
        latestRevisionNumber: 1,
        version: 0,
      }),
    });
    expect(
      await postMemoByAi({
        container: containerWith(gateway),
        input: { userId: "u", body: "hello", actor: ACTOR },
      }),
    ).toEqual({ memo: { id: "m1", body: "hello", postedAt: NOW } });
    expect(calls[0]?.args).toEqual(["u", { body: "hello", actor: ACTOR }]);
  });

  it("update_memo and get pass the memo id through; delete is the soft delete", async () => {
    const calls: Call[] = [];
    const gateway = memoGateway(calls, {
      updateMemoByAi: async () => ({
        result: "saved",
        memo: { id: "m1", body: "b", postedAt: NOW, latestRevisionNumber: 2 },
      }),
      getMemo: async () => ({
        id: "m1",
        body: "b",
        postedAt: NOW,
        updatedAt: NOW,
        latestRevisionNumber: 2,
        version: 3,
      }),
      softDeleteMemo: async () => undefined,
    });
    const container = containerWith(gateway);
    expect(
      (
        await updateMemoByAi({
          container,
          input: { userId: "u", memoId: "m1", body: "b", actor: ACTOR },
        })
      ).result,
    ).toBe("saved");
    const got = await getMemo({
      container,
      input: { userId: "u", memoId: "m1" },
    });
    expect(got.memo).toEqual({
      id: "m1",
      body: "b",
      postedAt: NOW,
      updatedAt: NOW,
      latestRevisionNumber: 2,
    });
    expect("version" in got.memo).toBe(false);
    await deleteMemoByAi({ container, input: { userId: "u", memoId: "m1" } });
    expect(calls.map((c) => c.name)).toEqual([
      "updateMemoByAi",
      "getMemo",
      "softDeleteMemo",
    ]);
  });

  it("recent_memos defaults to 20 and refuses a limit outside 1..100 before any call", async () => {
    const calls: Call[] = [];
    const gateway = memoGateway(calls, {
      recentMemos: async () => ({ items: [] }),
    });
    const container = containerWith(gateway);
    await recentMemos({ container, input: { userId: "u" } });
    expect(calls[0]?.args).toEqual(["u", { limit: 20 }]);
    for (const limit of [0, 101, 2.5]) {
      let caught: unknown = null;
      try {
        await recentMemos({ container, input: { userId: "u", limit } });
      } catch (error) {
        caught = error;
      }
      expect(isValidationError(caught)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });
});
