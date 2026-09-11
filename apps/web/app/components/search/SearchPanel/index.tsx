"use client";

import type {
  SearchOutputView,
  SearchResultItemView,
} from "@repo/core/application/search/view";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState, useTransition } from "react";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
import { searchMoreFn } from "../actions";
import { isSearchOutput } from "../schema";
import { compactSearch, type SearchPageSearch } from "../search";

export type SearchTopicChip = Readonly<{
  id: string;
  name: string;
  archived: boolean;
}>;

export type SearchPanelInitial =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "results"; page: SearchOutputView }>
  | Readonly<{ kind: "topicMissing" }>;

export type SearchPanelProps = Readonly<{
  topics: readonly SearchTopicChip[];
  search: SearchPageSearch;
  initial: SearchPanelInitial;
}>;

// A chip is the current scope only when the URL's search equals its own.
// `Link`'s default match is partial on search, which makes 「すべて」 ({q})
// active under every {q, topic} too; and an active `Link` always stamps
// `aria-current="page"`, so that attribute is the one the style keys on.
const CHIP_ACTIVE = { exact: true } as const;

/**
 * P-11: the keyword box, the topic chips (「すべて」 + every live topic,
 * archived ones marked), and the result list with 「もっと読む」. A search
 * is a navigation — the URL carries `q` / `topic` — so the route streams
 * the first page; only the continuation is fetched from here. A blank
 * keyword never navigates (S-SE-01 edge case).
 */
export function SearchPanel({ topics, search, initial }: SearchPanelProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const more = useServerFn(searchMoreFn);
  const [items, setItems] = useState<readonly SearchResultItemView[]>(
    initial.kind === "results" ? initial.page.items : [],
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    initial.kind === "results" ? initial.page.nextCursor : null,
  );
  const [loadingMore, startMore] = useTransition();
  const [moreError, setMoreError] = useState<Readonly<{
    message: string;
    expired: boolean;
  }> | null>(null);
  const keyword = search.q;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const q = (form.elements.namedItem("q") as HTMLInputElement).value.trim();
    if (q.length === 0) return;
    void navigate({
      to: "/search",
      search: compactSearch({ q, topic: search.topic }),
    });
  };

  // Not guarded on `loadingMore`: a transition stays pending until its
  // async action settles, so a retry clicked right after the failure
  // rendered would be dropped. The button itself is disabled while pending.
  const loadMore = () => {
    if (keyword === undefined || nextCursor === null) return;
    startMore(async () => {
      try {
        const page = readServerFnResult(
          await more({
            data: {
              q: keyword,
              ...(search.topic === undefined ? {} : { topic: search.topic }),
              cursor: nextCursor,
            },
          }),
          isSearchOutput,
          "searchMoreFn",
        );
        setItems((current) => [...current, ...page.items]);
        setNextCursor(page.nextCursor);
        setMoreError(null);
      } catch (failure) {
        const serialized = toDisplayError(failure);
        const expired =
          serialized.kind === "business" &&
          serialized.code === "INVALID_CURSOR";
        setMoreError({
          message: expired
            ? "検索結果の続きを読めなくなりました。もう一度検索してください"
            : displayError(failure),
          expired,
        });
      }
    });
  };

  return (
    <div className="fog-search">
      <search>
        <form
          className="fog-search-box"
          onSubmit={submit}
          aria-label="メモとドキュメントを検索"
        >
          <SearchIcon />
          <input
            type="search"
            name="q"
            defaultValue={keyword ?? ""}
            placeholder="メモとドキュメントを検索…"
            aria-label="キーワード"
            maxLength={500}
            autoComplete="off"
          />
          <button type="submit" className="fog-secondary">
            検索
          </button>
        </form>
      </search>
      <ul className="fog-chips" aria-label="トピックで絞り込む">
        <li>
          <Link
            to="/search"
            search={compactSearch({ q: keyword })}
            className="fog-chip"
            activeOptions={CHIP_ACTIVE}
          >
            すべて
          </Link>
        </li>
        {topics.map((topic) => (
          <li key={topic.id}>
            <Link
              to="/search"
              search={compactSearch({ q: keyword, topic: topic.id })}
              className="fog-chip"
              activeOptions={CHIP_ACTIVE}
            >
              {topic.name}
              {topic.archived && <span className="fog-badge">完了</span>}
            </Link>
          </li>
        ))}
      </ul>
      {initial.kind === "idle" && (
        <p className="fog-search-idle" role="status">
          キーワードを入力すると、メモとドキュメントを横断して検索します。
        </p>
      )}
      {initial.kind === "topicMissing" && (
        <div className="fog-empty" role="status">
          <h2>絞り込み対象のトピックが見つかりません</h2>
          <p>削除されたか、URL のトピック ID が正しくありません。</p>
          <p>
            <Link
              to="/search"
              search={compactSearch({ q: keyword })}
              className="fog-secondary fog-link-button"
            >
              絞り込みを解除して検索する
            </Link>
          </p>
        </div>
      )}
      {initial.kind === "results" && keyword !== undefined && (
        <ResultList
          keyword={keyword}
          count={initial.page.count}
          items={items}
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          moreError={moreError}
          onMore={loadMore}
          onRetry={() => {
            setMoreError(null);
            void router.invalidate();
          }}
        />
      )}
    </div>
  );
}

function ResultList({
  keyword,
  count,
  items,
  nextCursor,
  loadingMore,
  moreError,
  onMore,
  onRetry,
}: Readonly<{
  keyword: string;
  count: number;
  items: readonly SearchResultItemView[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreError: Readonly<{ message: string; expired: boolean }> | null;
  onMore: () => void;
  onRetry: () => void;
}>) {
  if (count === 0) {
    return (
      <div className="fog-empty" role="status">
        <h2>見つかりませんでした</h2>
        <p>「{keyword}」に一致するメモ・ドキュメントはありません。</p>
      </div>
    );
  }
  return (
    <section className="fog-search-results" aria-label="検索結果">
      <p className="fog-result-count">{count}件</p>
      <ol className="fog-result-rows">
        {items.map((item) => (
          <li key={`${item.type}:${item.id}`}>
            <ResultRow item={item} keyword={keyword} />
          </li>
        ))}
      </ol>
      {moreError !== null && (
        <p className="fog-error" role="alert">
          {moreError.message}
          {moreError.expired ? (
            <button type="button" className="fog-text-button" onClick={onRetry}>
              もう一度検索
            </button>
          ) : (
            <button type="button" className="fog-text-button" onClick={onMore}>
              再試行
            </button>
          )}
        </p>
      )}
      {nextCursor !== null && moreError === null && (
        <div className="fog-search-more">
          <button
            type="button"
            className="fog-secondary"
            onClick={onMore}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? "読み込み中…" : "もっと読む"}
          </button>
        </div>
      )}
    </section>
  );
}

function ResultRow({
  item,
  keyword,
}: Readonly<{ item: SearchResultItemView; keyword: string }>) {
  const body = (
    <div className="fog-result-main">
      <span className="fog-result-type">
        {item.type === "memo" ? "メモ" : "ドキュメント"}
      </span>
      <p className="fog-result-snippet">
        <Highlighted text={item.snippet} keyword={keyword} />
      </p>
      <div className="fog-result-meta">
        <time dateTime={item.timestamp.toISOString()}>
          {formatDateTime(item.timestamp)}
        </time>
        {item.type === "document" && (
          <span className="fog-result-topic">{item.topicName}</span>
        )}
      </div>
    </div>
  );
  const jump = (
    <span className="fog-result-jump" aria-hidden="true">
      <JumpIcon />
    </span>
  );
  return item.type === "memo" ? (
    <Link to="/" search={{ memo: item.id }} className="fog-result-row">
      {body}
      {jump}
    </Link>
  ) : (
    <Link
      to="/documents/$documentId"
      params={{ documentId: item.id }}
      className="fog-result-row"
    >
      {body}
      {jump}
    </Link>
  );
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("ja", { granularity: "grapheme" })
    : null;

function graphemesOf(text: string): string[] {
  if (graphemeSegmenter === null) return Array.from(text);
  const out: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment);
  return out;
}

const fold = (value: string) => value.normalize("NFKC").toLowerCase();

/**
 * Marks the keyword in the snippet. The match is found on the NFKC
 * lower-cased text, grapheme by grapheme — the same folding the index and
 * the snippet use — so a half-width keyword marks its full-width original;
 * what is marked is the original text, never the folded one.
 */
export function Highlighted({
  text,
  keyword,
}: Readonly<{ text: string; keyword: string }>) {
  const needle = fold(keyword.trim());
  if (needle.length === 0) return <>{text}</>;
  const graphemes = graphemesOf(text);
  const starts: number[] = [];
  let folded = "";
  for (const grapheme of graphemes) {
    starts.push(folded.length);
    folded += fold(grapheme);
  }
  const hit = folded.indexOf(needle);
  if (hit < 0) return <>{text}</>;
  let from = starts.length - 1;
  while (from > 0 && (starts[from] as number) > hit) from -= 1;
  let to = from;
  while (to < graphemes.length && (starts[to] as number) < hit + needle.length)
    to += 1;
  return (
    <>
      {graphemes.slice(0, from).join("")}
      <mark>{graphemes.slice(from, to).join("")}</mark>
      {graphemes.slice(to).join("")}
    </>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
    >
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M13.5 13.5L17 17"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function JumpIcon() {
  return (
    <svg
      aria-hidden="true"
      width="19"
      height="19"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M5 15L15 5M15 5H7.5M15 5V12.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
