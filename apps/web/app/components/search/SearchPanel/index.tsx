"use client";

import type {
  SearchOutputView,
  SearchResultItemView,
} from "@repo/core/application/search/view";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingRow } from "@/components/ui/LoadingRow";
import { RowLink } from "@/components/ui/RowLink";
import { RowList } from "@/components/ui/RowList";
import { toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { formatDateTime } from "@/presentation/time";
import { searchMoreFn } from "../actions";
import { SearchBox } from "../SearchBox";
import { isSearchOutput } from "../schema";
import { compactSearch, type SearchPageSearch } from "../search";
import {
  CHIP_CLASS,
  CHIP_CURRENT_CLASS,
  CHIP_IDLE_CLASS,
  CHIP_LIST_CLASS,
} from "../styles";

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

type MoreError = "failed" | "expired";

// A chip is the current scope only when the URL's search equals its own.
// `Link`'s default match is partial on search, which makes 「すべて」 ({q})
// active under every {q, topic} too.
const CHIP_ACTIVE = { exact: true } as const;
const CHIP_CURRENT_PROPS = { className: CHIP_CURRENT_CLASS } as const;
const CHIP_IDLE_PROPS = {
  className: `${CHIP_IDLE_CLASS} hover:bg-neutral-100 hover:text-neutral-900`,
} as const;

/**
 * P-11 (`spec/design/pages/search.html`): the keyword box, the topic chips
 * (「すべて」 + every live topic, archived ones marked), and the result rows
 * with 「もっと読む」. A search is a navigation — the URL carries `q` /
 * `topic` — so the route streams the first page; only the continuation is
 * fetched from here. A blank keyword never navigates (S-SE-01 edge case).
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
  const [moreError, setMoreError] = useState<MoreError | null>(null);
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

  // The failure is cleared outside the transition so the retry control
  // gives way to the spinner at once; nothing that starts a load is on
  // screen while one is in flight.
  const loadMore = () => {
    if (keyword === undefined || nextCursor === null) return;
    setMoreError(null);
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
      } catch (failure) {
        const serialized = toDisplayError(failure);
        setMoreError(
          serialized.kind === "business" && serialized.code === "INVALID_CURSOR"
            ? "expired"
            : "failed",
        );
      }
    });
  };

  return (
    <div className="flex flex-col gap-lg">
      <SearchBox defaultValue={keyword ?? ""} onSubmit={submit} />
      <ul className={CHIP_LIST_CLASS} aria-label="トピックで絞り込む">
        <li>
          <Link
            to="/search"
            search={compactSearch({ q: keyword })}
            className={CHIP_CLASS}
            activeOptions={CHIP_ACTIVE}
            activeProps={CHIP_CURRENT_PROPS}
            inactiveProps={CHIP_IDLE_PROPS}
          >
            すべて
          </Link>
        </li>
        {topics.map((topic) => (
          <li key={topic.id}>
            <Link
              to="/search"
              search={compactSearch({ q: keyword, topic: topic.id })}
              className={CHIP_CLASS}
              activeOptions={CHIP_ACTIVE}
              activeProps={CHIP_CURRENT_PROPS}
              inactiveProps={CHIP_IDLE_PROPS}
            >
              {({ isActive }) => (
                <>
                  {topic.name}
                  {topic.archived && <ArchivedBadge current={isActive} />}
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {initial.kind === "idle" && (
        <div role="status">
          <EmptyState message="キーワードでメモとドキュメントを探せます" />
        </div>
      )}
      {initial.kind === "topicMissing" && (
        <div role="status">
          <EmptyState
            message="絞り込みのトピックが見つかりません"
            action={
              <ButtonLink
                variant="text"
                to="/search"
                search={compactSearch({ q: keyword })}
              >
                絞り込みを解除して検索
              </ButtonLink>
            }
          />
        </div>
      )}
      {initial.kind === "results" && keyword !== undefined && (
        <ResultList
          keyword={keyword}
          scoped={search.topic !== undefined}
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

/**
 * The mark of an archived topic on its chip. On the current chip's tint it
 * takes the `lighter`-surface text (`.selection-badge` in
 * `memo-history.html`); on an idle chip, the label gray.
 */
function ArchivedBadge({ current }: Readonly<{ current: boolean }>) {
  return (
    <span
      className={`rounded-full bg-bg-card px-sm text-xs font-medium leading-tight ${current ? "text-primary-darker" : "text-neutral-600"}`}
    >
      完了
    </span>
  );
}

function ResultList({
  keyword,
  scoped,
  count,
  items,
  nextCursor,
  loadingMore,
  moreError,
  onMore,
  onRetry,
}: Readonly<{
  keyword: string;
  /** A topic narrows the search, so a zero result can be widened. */
  scoped: boolean;
  count: number;
  items: readonly SearchResultItemView[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreError: MoreError | null;
  onMore: () => void;
  onRetry: () => void;
}>) {
  if (count === 0) {
    return (
      <div role="status">
        <EmptyState
          message={`「${keyword}」に一致するメモ・ドキュメントは見つかりませんでした`}
          action={
            scoped ? (
              <ButtonLink
                variant="text"
                to="/search"
                search={compactSearch({ q: keyword })}
              >
                絞り込みを解除
              </ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  }
  return (
    <section aria-label="検索結果">
      <p className="font-base text-xs font-medium leading-tight tracking-label text-neutral-400 next-sibling:mt-md">
        {count}件
      </p>
      <RowList ordered>
        {items.map((item) => (
          <li key={`${item.type}:${item.id}`}>
            <ResultRow item={item} keyword={keyword} />
          </li>
        ))}
      </RowList>
      {moreError === "failed" && (
        <div role="alert">
          <EmptyState
            message="読み込めませんでした"
            action={
              <Button variant="text" onClick={onMore}>
                再試行
              </Button>
            }
          />
        </div>
      )}
      {moreError === "expired" && (
        <div role="alert">
          <EmptyState
            message="検索結果の続きを読めなくなりました"
            action={
              <Button variant="text" onClick={onRetry}>
                もう一度検索
              </Button>
            }
          />
        </div>
      )}
      {moreError === null && loadingMore && <LoadingRow label="読み込み中" />}
      {moreError === null && !loadingMore && nextCursor !== null && (
        <div className="flex justify-center pt-lg">
          <Button variant="outline" onClick={onMore}>
            もっと読む
          </Button>
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
    <span className="flex flex-col gap-sm">
      <span className="self-start rounded-full border border-neutral-300 px-sm py-xs text-xs font-medium leading-tight text-neutral-600">
        {item.type === "memo" ? "メモ" : "ドキュメント"}
      </span>
      <span className="wrap-anywhere">
        <Highlighted text={item.snippet} keyword={keyword} />
      </span>
      <span className="flex flex-wrap items-center gap-x-md text-xs leading-tight text-neutral-400">
        <time dateTime={item.timestamp.toISOString()} className="tabular-nums">
          {formatDateTime(item.timestamp)}
        </time>
        {item.type === "document" && (
          <span className="text-neutral-500">{item.topicName}</span>
        )}
      </span>
    </span>
  );
  return item.type === "memo" ? (
    <RowLink to="/" search={{ memo: item.id }}>
      {body}
    </RowLink>
  ) : (
    <RowLink to="/documents/$documentId" params={{ documentId: item.id }}>
      {body}
    </RowLink>
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
      <mark className="box-decoration-clone rounded-sm bg-primary-lighter p-xs font-medium text-primary-darker">
        {graphemes.slice(from, to).join("")}
      </mark>
      {graphemes.slice(to).join("")}
    </>
  );
}
