import {
  isSystemError,
  isValidationError,
} from "@repo/core/application/errors";
import type { UserDataUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import type { TopicId } from "@repo/core/domain/knowledge/valueObject";
import type {
  SearchPage,
  SearchQuery,
} from "@repo/core/domain/search/valueObject";
import { describe, expect, it, vi } from "vitest";
import { memoContainer } from "../../memo/__tests__/memoContainer";
import type { SearchGateway } from "../gateway";
import { search, searchProcedure } from "../search";

const emptyPage = async () => ({ items: [], count: 0, nextCursor: null });

const container = (overrides: { search?: SearchGateway["search"] }) => ({
  ...memoContainer({}),
  searchGateway: { search: overrides.search ?? vi.fn(emptyPage) },
});

describe("search (request side)", () => {
  it("passes the DTO through unchanged, defaulting the absent scope and cursor to null", async () => {
    const gateway = vi.fn<SearchGateway["search"]>(emptyPage);
    await search({
      container: container({ search: gateway }),
      input: { userId: "u1", keyword: "  fog ", limit: 20 },
    });
    expect(gateway).toHaveBeenCalledWith("u1", {
      keyword: "  fog ",
      topicId: null,
      cursor: null,
      limit: 20,
    });
    await search({
      container: container({ search: gateway }),
      input: {
        userId: "u1",
        keyword: "fog",
        topicId: "t1",
        cursor: "c",
        limit: 1,
      },
    });
    expect(gateway).toHaveBeenLastCalledWith("u1", {
      keyword: "fog",
      topicId: "t1",
      cursor: "c",
      limit: 1,
    });
  });

  it("refuses a limit outside 1..100 before calling the gateway", async () => {
    const gateway = vi.fn<SearchGateway["search"]>(emptyPage);
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await expect(
        search({
          container: container({ search: gateway }),
          input: { userId: "u1", keyword: "fog", limit },
        }),
      ).rejects.toSatisfy(
        (error) => isValidationError(error) && error.code === "INVALID_LIMIT",
      );
    }
    expect(gateway).not.toHaveBeenCalled();
  });
});

function fakeContext(page: SearchPage, names: Record<string, string>) {
  const query = vi.fn((_query: SearchQuery) => page);
  const listSummariesByIds = vi.fn((ids: readonly TopicId[]) =>
    ids.flatMap((id) =>
      id in names ? [{ id, name: names[id] as string }] : [],
    ),
  );
  const ctx = {
    searchIndex: { query },
    topicRepository: { listSummariesByIds },
  } as unknown as UserDataUnitOfWorkContext;
  return { ctx, query, listSummariesByIds };
}

const AT = new Date("2026-09-08T00:00:00Z");

describe("searchProcedure", () => {
  it("resolves topic names in one call and projects both item kinds", () => {
    const { ctx, query, listSummariesByIds } = fakeContext(
      {
        items: [
          {
            type: "document",
            id: "d1" as never,
            snippet: "s1",
            timestamp: AT,
            topicId: "t1" as never,
            sourceMemoIds: ["m1" as never],
          },
          {
            type: "memo",
            id: "m1" as never,
            snippet: "s2",
            timestamp: AT,
            sourceOfDocumentIds: ["d1" as never],
          },
          {
            type: "document",
            id: "d2" as never,
            snippet: "s3",
            timestamp: AT,
            topicId: "t1" as never,
            sourceMemoIds: [],
          },
          {
            type: "document",
            id: "d3" as never,
            snippet: "s4",
            timestamp: AT,
            topicId: "t2" as never,
            sourceMemoIds: [],
          },
        ],
        count: 4,
        nextCursor: "next" as never,
      },
      { t1: "読書", t2: "仕事" },
    );
    const out = searchProcedure(ctx, {
      keyword: " fog ",
      topicId: "t1",
      cursor: "cur",
      limit: 20,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toEqual({
      keyword: "fog",
      limit: 20,
      topicId: "t1",
      cursor: "cur",
    });
    expect(listSummariesByIds).toHaveBeenCalledTimes(1);
    expect(listSummariesByIds).toHaveBeenCalledWith(["t1", "t2"]);
    expect(out).toEqual({
      items: [
        {
          type: "document",
          id: "d1",
          snippet: "s1",
          timestamp: AT,
          topicId: "t1",
          topicName: "読書",
          sourceMemoIds: ["m1"],
        },
        {
          type: "memo",
          id: "m1",
          snippet: "s2",
          timestamp: AT,
          sourceOfDocumentIds: ["d1"],
        },
        {
          type: "document",
          id: "d2",
          snippet: "s3",
          timestamp: AT,
          topicId: "t1",
          topicName: "読書",
          sourceMemoIds: [],
        },
        {
          type: "document",
          id: "d3",
          snippet: "s4",
          timestamp: AT,
          topicId: "t2",
          topicName: "仕事",
          sourceMemoIds: [],
        },
      ],
      count: 4,
      nextCursor: "next",
    });
  });

  it("skips the topic read when no document matched and carries a missing cursor as null", () => {
    const { ctx, listSummariesByIds } = fakeContext(
      {
        items: [
          {
            type: "memo",
            id: "m1" as never,
            snippet: "s",
            timestamp: AT,
            sourceOfDocumentIds: [],
          },
        ],
        count: 1,
      },
      {},
    );
    const out = searchProcedure(ctx, {
      keyword: "fog",
      topicId: null,
      cursor: null,
      limit: 5,
    });
    expect(listSummariesByIds).not.toHaveBeenCalled();
    expect(out.nextCursor).toBeNull();
  });

  it("treats a document whose topic is not live as a data-integrity failure", () => {
    const { ctx } = fakeContext(
      {
        items: [
          {
            type: "document",
            id: "d1" as never,
            snippet: "s",
            timestamp: AT,
            topicId: "gone" as never,
            sourceMemoIds: [],
          },
        ],
        count: 1,
      },
      {},
    );
    expect(() =>
      searchProcedure(ctx, {
        keyword: "fog",
        topicId: null,
        cursor: null,
        limit: 5,
      }),
    ).toThrow(
      expect.toSatisfy(
        (error: unknown) =>
          isSystemError(error) && error.code === "DATA_INTEGRITY_ERROR",
      ),
    );
  });
});
