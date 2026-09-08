import { createIdentityTuning } from "@repo/core/application/identity/tuning";
import type { UsecaseContainer } from "@repo/core/application/types";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import {
  FakeIdGenerator,
  FakeLogger,
  FakePasswordHasher,
  FakeTokenGenerator,
  trippingExportGateway,
  trippingIdentityGateway,
  trippingKnowledgeGateway,
  trippingMemoGateway,
  trippingSearchGateway,
  trippingTrashGateway,
} from "../../__tests__/fakes";
import { isValidationError } from "../../errors";
import { createDocument } from "../createDocument";
import { createTopic } from "../createTopic";
import { diffDocumentRevisions } from "../diffDocumentRevisions";
import { editDocument } from "../editDocument";
import type {
  CreateDocumentDto,
  EditDocumentDto,
  KnowledgeGateway,
  UpdateTopicDto,
} from "../gateway";
import { rollbackDocument } from "../rollbackDocument";
import { updateTopic } from "../updateTopic";

const NOW = new Date("2026-09-08T00:00:00.000Z");

function knowledgeContainer(
  overrides: Partial<KnowledgeGateway>,
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
    identityGateway: trippingIdentityGateway((name) => {
      throw new Error(`unexpected identity gateway call: ${name}`);
    }),
    identityTuning: createIdentityTuning(),
    memoGateway: trippingMemoGateway((name) => {
      throw new Error(`unexpected memo gateway call: ${name}`);
    }),
    knowledgeGateway: trippingKnowledgeGateway((name) => {
      throw new Error(`unexpected knowledge gateway call: ${name}`);
    }, overrides),
    searchGateway: trippingSearchGateway((name) => {
      throw new Error(`unexpected search gateway call: ${name}`);
    }),
    trashGateway: trippingTrashGateway((name) => {
      throw new Error(`unexpected trash gateway call: ${name}`);
    }),
    exportGateway: trippingExportGateway((name) => {
      throw new Error(`unexpected export gateway call: ${name}`);
    }),
    passwordHasher: new FakePasswordHasher(),
  };
}

const TOPIC = {
  id: "t1",
  name: "n",
  description: null,
  status: "active",
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

describe("createTopic / updateTopic (request side)", () => {
  it("defaults the description to null and hands primitives to the gateway", async () => {
    const calls: unknown[] = [];
    const container = knowledgeContainer({
      createTopic: async (userId, input) => {
        calls.push([userId, input]);
        return TOPIC;
      },
    });
    await createTopic({ container, input: { userId: "u", name: "n" } });
    expect(calls).toEqual([["u", { name: "n", description: null }]]);
  });

  it("refuses an update that names nothing to change, and carries only the given fields", async () => {
    const calls: UpdateTopicDto[] = [];
    const container = knowledgeContainer({
      updateTopic: async (_userId, input) => {
        calls.push(input);
        return TOPIC;
      },
    });
    await expect(
      updateTopic({ container, input: { userId: "u", topicId: "t1" } }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isValidationError(error) && error.code === "NO_CHANGES",
    );
    await updateTopic({
      container,
      input: { userId: "u", topicId: "t1", description: null },
    });
    await updateTopic({
      container,
      input: { userId: "u", topicId: "t1", archived: false, name: "x" },
    });
    expect(calls).toEqual([
      { topicId: "t1", description: null },
      { topicId: "t1", name: "x", archived: false },
    ]);
  });
});

describe("createDocument / editDocument / rollbackDocument (request side)", () => {
  it("passes the actor as primitives and a blank change reason as null", async () => {
    const calls: CreateDocumentDto[] = [];
    const container = knowledgeContainer({
      createDocument: async (_userId, input) => {
        calls.push(input);
        return {
          id: "d1",
          topicId: "t1",
          title: "t",
          body: "",
          latestRevision: 1,
          version: 0,
          createdAt: NOW,
          updatedAt: NOW,
          sourceMemoIds: [],
        };
      },
    });
    await createDocument({
      container,
      input: {
        userId: "u",
        actor: Actor.user(UserId.create("u")),
        topicId: "t1",
        title: "t",
        body: "",
        sourceMemoIds: ["m1"],
      },
    });
    expect(calls).toEqual([
      {
        actor: { kind: "user", userId: "u" },
        topicId: "t1",
        title: "t",
        body: "",
        sourceMemoIds: ["m1"],
        changeReason: null,
      },
    ]);
  });

  it("limits editDocument and rollbackDocument to a human actor at the type level", async () => {
    const edits: EditDocumentDto[] = [];
    const container = knowledgeContainer({
      editDocument: async (_userId, input) => {
        edits.push(input);
        return {
          result: "saved",
          latestRevision: 2,
          version: 1,
          updatedAt: NOW,
          conflict: null,
        };
      },
      rollbackDocument: async () => ({
        changed: true,
        latestRevision: 3,
        version: 2,
        updatedAt: NOW,
      }),
    });
    await editDocument({
      container,
      input: {
        userId: "u",
        actor: Actor.user(UserId.create("u")),
        documentId: "d1",
        title: "t",
        body: "b",
        expectedVersion: 0,
        changeReason: "   ",
      },
    });
    expect(edits[0]).toMatchObject({
      actor: { kind: "user", userId: "u" },
      expectedVersion: 0,
      changeReason: null,
    });
    const aiActor = {
      kind: "aiClient",
      userId: UserId.create("u"),
      connectionId: "c",
      clientName: "Claude",
    } as const;
    await expect(
      rollbackDocument({
        container,
        input: {
          userId: "u",
          // @ts-expect-error rollback is not on the AI's scope
          actor: aiActor,
          documentId: "d1",
          revisionNumber: 1,
        },
      }),
    ).resolves.toMatchObject({ changed: true });
  });

  it("refuses the same revision twice before reaching the gateway", async () => {
    const container = knowledgeContainer({
      diffDocumentRevisions: async () => {
        throw new Error("must not be reached");
      },
    });
    await expect(
      diffDocumentRevisions({
        container,
        input: {
          userId: "u",
          documentId: "d1",
          baseRevisionNumber: 2,
          targetRevisionNumber: 2,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isValidationError(error) && error.code === "SAME_REVISION",
    );
  });
});
