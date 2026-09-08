import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import {
  SearchCursor,
  SearchQuery,
} from "@repo/core/domain/search/valueObject";
import { SystemError, SystemErrorCode, ValidationError } from "../errors";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { SearchQueryDto } from "./gateway";
import type { SearchOutputView, SearchResultItemView } from "./view";

export const SEARCH_MAX_LIMIT = 100;

export type SearchInput = Readonly<{
  userId: string;
  keyword: string;
  topicId?: string | null;
  cursor?: string | null;
  limit: number;
}>;

/** The shape check the transport may have skipped; the value object trusts it. */
function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new ValidationError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${SEARCH_MAX_LIMIT}`,
    );
  }
  return limit;
}

/**
 * S-SE-01 / S-SE-02, request side. The one search both faces share: the
 * screen and (from PH-07) the AI client call this and nothing else.
 */
export async function search({
  container,
  input,
}: ServiceArgs<SearchInput>): Promise<SearchOutputView> {
  return container.searchGateway.search(input.userId, {
    keyword: input.keyword,
    topicId: input.topicId ?? null,
    cursor: input.cursor ?? null,
    limit: checkLimit(input.limit),
  });
}

/**
 * Inside the DO. Runs the index query, then resolves the documents' topic
 * names in one `listSummariesByIds` — the only addition the usecase makes
 * to what the index returned.
 */
export function searchProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: SearchQueryDto,
): SearchOutputView {
  const page = ctx.searchIndex.query(
    SearchQuery.create({
      keyword: dto.keyword,
      limit: checkLimit(dto.limit),
      topicId: dto.topicId === null ? undefined : TopicId.create(dto.topicId),
      cursor: dto.cursor === null ? undefined : SearchCursor.create(dto.cursor),
    }),
  );
  const topicIds = [
    ...new Set(
      page.items.flatMap((item) =>
        item.type === "document" ? [item.topicId] : [],
      ),
    ),
  ];
  const names = new Map(
    topicIds.length === 0
      ? []
      : ctx.topicRepository
          .listSummariesByIds(topicIds)
          .map((summary) => [summary.id, summary.name] as const),
  );
  const items: SearchResultItemView[] = page.items.map((item) => {
    if (item.type === "memo") {
      return {
        type: "memo",
        id: item.id,
        snippet: item.snippet,
        timestamp: item.timestamp,
        sourceOfDocumentIds: item.sourceOfDocumentIds,
      };
    }
    const topicName = names.get(item.topicId);
    // An active document always belongs to a live topic (`spec/usecases/search.md` step 4).
    if (topicName === undefined) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        "An active document points at a topic that is not live",
      );
    }
    return {
      type: "document",
      id: item.id,
      snippet: item.snippet,
      timestamp: item.timestamp,
      topicId: item.topicId,
      topicName,
      sourceMemoIds: item.sourceMemoIds,
    };
  });
  return { items, count: page.count, nextCursor: page.nextCursor ?? null };
}
