import type { SearchIndexPort, SearchPage, SearchQuery } from "./contracts";

export class UiSearchConsumer {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  search(query: SearchQuery): Promise<SearchPage> {
    return this.searchIndex.query(query);
  }
}

export class AiSearchConsumer {
  constructor(private readonly searchIndex: SearchIndexPort) {}

  search(query: SearchQuery): Promise<SearchPage> {
    return this.searchIndex.query(query);
  }
}
