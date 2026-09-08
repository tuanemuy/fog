import type { SearchPage, SearchQuery } from "../valueObject";

/**
 * The read side of the full-text index. Synchronous: the index lives in the
 * same SQLite as the rows it projects. There is no write side here on
 * purpose — entries are rebuilt inside the repositories' own transactions
 * (`stores/searchProjection.ts`), and a port would let that be bypassed.
 *
 * Contract (`spec/domains/search.md` 検索の規則): trashed rows never match
 * (they have no entry), archived topics do, an unknown or trashed `topicId`
 * is `NotFoundError("TOPIC_NOT_FOUND")`, ties break on
 * `timestamp DESC, type, id`, and a cursor reads the set its first page
 * froze until it expires — after which, or when it cannot be read at all,
 * `BusinessRuleError(SearchErrorCode.InvalidCursor)`.
 */
export interface SearchIndexPort {
  query(query: SearchQuery): SearchPage;
}
