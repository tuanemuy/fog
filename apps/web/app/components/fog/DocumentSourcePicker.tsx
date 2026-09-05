"use client";

import type { MemoView, TimelinePage } from "@repo/core/application/fog/types";
import { useServerFn } from "@tanstack/react-start";
import { useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { searchFogSourceMemos } from "@/presentation/fogDocumentActions";

const date = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Tokyo",
});

export function DocumentSourcePicker({
  selected,
  onChange,
  disabled,
}: {
  selected: MemoView[];
  onChange: (memos: MemoView[]) => void;
  disabled: boolean;
}) {
  const search = useServerFn(searchFogSourceMemos);
  const [keyword, setKeyword] = useState("");
  const [searchedKeyword, setSearchedKeyword] = useState("");
  const [page, setPage] = useState<TimelinePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, transition] = useTransition();
  const run = (cursor?: string) =>
    transition(async () => {
      setError(null);
      const query = cursor ? searchedKeyword : keyword;
      try {
        const next = await search({
          data: { keyword: query, ...(cursor ? { cursor } : {}) },
        });
        setPage((current) => ({
          ...next,
          memos:
            cursor && current ? [...current.memos, ...next.memos] : next.memos,
        }));
        setSearchedKeyword(query);
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  return (
    <section
      className="fog-source-picker"
      aria-labelledby="source-title"
      aria-busy={pending}
    >
      <h3 id="source-title">出典メモ（任意）</h3>
      {selected.map((memo) => (
        <div key={memo.id} className="fog-source-selected">
          <p>{memo.body}</p>
          <button
            type="button"
            className="fog-text-button"
            disabled={disabled}
            aria-label={`${memo.body.slice(0, 20)}を出典から外す`}
            onClick={() =>
              onChange(selected.filter((item) => item.id !== memo.id))
            }
          >
            外す
          </button>
        </div>
      ))}
      <label className="fog-sr-only" htmlFor="source-search">
        出典メモを検索
      </label>
      <div className="fog-source-search">
        <input
          id="source-search"
          type="search"
          placeholder="メモのキーワード"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          maxLength={500}
          disabled={disabled || pending}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              run();
            }
          }}
        />
        <button
          type="button"
          className="fog-secondary"
          onClick={() => run()}
          disabled={disabled || pending}
        >
          {pending ? "検索中…" : "検索"}
        </button>
      </div>
      {error && (
        <p role="alert" className="fog-error">
          {error}
        </p>
      )}
      {page?.memos.map((memo) => (
        <label className="fog-source-option" key={memo.id}>
          <input
            type="checkbox"
            checked={selected.some((item) => item.id === memo.id)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, memo]
                  : selected.filter((item) => item.id !== memo.id),
              )
            }
          />
          <span>
            <time className="fog-meta" dateTime={memo.createdAt}>
              {date.format(new Date(memo.createdAt))}
            </time>
            <span className="fog-source-text">{memo.body}</span>
          </span>
        </label>
      ))}
      {page?.memos.length === 0 && (
        <p className="fog-empty-inline">一致するメモはありません。</p>
      )}
      {page?.nextCursor && (
        <button
          type="button"
          className="fog-text-button"
          disabled={disabled || pending}
          onClick={() => run(page.nextCursor ?? undefined)}
        >
          さらに読み込む
        </button>
      )}
    </section>
  );
}
