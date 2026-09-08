import type { SearchOutputView } from "./view";

/** Primitives only: value objects are rebuilt inside the Durable Object. */
export type SearchQueryDto = Readonly<{
  keyword: string;
  topicId: string | null;
  cursor: string | null;
  limit: number;
}>;

export interface SearchGateway {
  search(userId: string, input: SearchQueryDto): Promise<SearchOutputView>;
}
