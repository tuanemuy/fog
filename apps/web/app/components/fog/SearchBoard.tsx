"use client";
import type { SearchResult, TopicView } from "@repo/core/application/fog/types";
import { Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { loadFogSearch } from "@/presentation/fogDataActions";
import type { FogSearch } from "@/presentation/fogDataSchema";

export function SearchBoard({
  page,
  topics,
  search,
}: {
  page: { items: SearchResult[]; nextCursor: string | null };
  topics: TopicView[];
  search: FogSearch;
}) {
  const router = useRouter();
  const load = useServerFn(loadFogSearch);
  const [query, setQuery] = useState(search.query);
  const [topicId, setTopicId] = useState(search.topicId ?? "");
  const [loaded, setLoaded] = useState<SearchResult[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const items = [
    ...new Map(
      [...page.items, ...loaded].map((item) => [
        `${item.kind}:${item.id}`,
        item,
      ]),
    ).values(),
  ];
  const next = cursor === undefined ? page.nextCursor : cursor;
  return (
    <section className="fog-content" aria-label="横断検索" aria-busy={pending}>
      <h2>メモとドキュメントを検索</h2>
      <form
        className="fog-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          start(async () => {
            await router.navigate({
              to: "/search",
              search: { query: query.trim(), ...(topicId ? { topicId } : {}) },
            });
          });
        }}
      >
        <label htmlFor="search-query">キーワード</label>
        <input
          id="search-query"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={500}
          placeholder="思い出した言葉から探す"
        />
        <label htmlFor="search-topic">トピック</label>
        <select
          id="search-topic"
          value={topicId}
          onChange={(event) => setTopicId(event.target.value)}
        >
          <option value="">すべてのトピック</option>
          {topics.map((topic) => (
            <option value={topic.id} key={topic.id}>
              {topic.title}
              {topic.completed ? "（完了済み）" : ""}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="fog-primary"
          disabled={pending || !query.trim()}
        >
          {pending ? "検索中…" : "検索"}
        </button>
        {(search.query || search.topicId) && (
          <Link className="fog-text-link" to="/search" search={{ query: "" }}>
            解除
          </Link>
        )}
      </form>
      {!search.query ? (
        <p className="fog-empty-inline">
          キーワードを入力すると、メモとドキュメントをまとめて探せます。
        </p>
      ) : items.length === 0 ? (
        <div className="fog-empty">
          <h3>見つかりませんでした</h3>
          <p>別のキーワードやトピックでお試しください。</p>
        </div>
      ) : (
        <section aria-label="検索結果">
          <p className="fog-meta">
            {items.length}件{next ? "以上" : ""}
          </p>
          {items.map((item) => (
            <Link
              key={`${item.kind}:${item.id}`}
              className="fog-search-result"
              to={item.kind === "memo" ? "/timeline" : "/documents/$documentId"}
              params={item.kind === "document" ? { documentId: item.id } : {}}
              search={item.kind === "memo" ? { memoId: item.id } : {}}
            >
              <div className="fog-section-heading">
                <span className="fog-badge">
                  {item.kind === "memo" ? "メモ" : "ドキュメント"}
                </span>
                <time dateTime={item.updatedAt} className="fog-meta">
                  {new Date(item.updatedAt).toLocaleString("ja-JP", {
                    timeZone: "Asia/Tokyo",
                  })}
                </time>
              </div>
              {item.title && <h3>{item.title}</h3>}
              <p className="fog-search-snippet">{item.snippet}</p>
              {item.topicTitle && (
                <span className="fog-meta">{item.topicTitle}</span>
              )}
            </Link>
          ))}
        </section>
      )}
      {error && (
        <p className="fog-error" role="alert">
          {error}
        </p>
      )}
      {next && (
        <button
          type="button"
          className="fog-secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const result = await load({
                  data: { ...search, cursor: next },
                });
                setLoaded((current) => [...current, ...result.items]);
                setCursor(result.nextCursor);
                setError(null);
              } catch (failure) {
                setError(displayError(failure));
              }
            })
          }
        >
          {pending ? "読込中…" : error ? "もう一度読み込む" : "もっと読む"}
        </button>
      )}
    </section>
  );
}
