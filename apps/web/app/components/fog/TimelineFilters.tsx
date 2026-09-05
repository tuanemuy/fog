"use client";

import { useRouter } from "@tanstack/react-router";
import { useState, useTransition } from "react";
import type { TimelineSearch } from "@/presentation/fogTimelineSchema";

export function TimelineFilters({ search }: { search: TimelineSearch }) {
  const router = useRouter();
  const [keyword, setKeyword] = useState(search.keyword ?? "");
  const [date, setDate] = useState(search.date ?? "");
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="fog-timeline-filters"
      aria-label="タイムラインを絞り込む"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          await router.navigate({
            to: "/timeline",
            search: {
              ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
              ...(date ? { date } : {}),
            },
          });
        });
      }}
    >
      <label>
        <span className="fog-sr-only">キーワード</span>
        <input
          type="search"
          placeholder="キーワードで絞り込む"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          maxLength={200}
        />
      </label>
      <label>
        <span className="fog-sr-only">日付へジャンプ</span>
        <input
          type="date"
          aria-label="日付へジャンプ"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </label>
      <button type="submit" className="fog-secondary" disabled={pending}>
        {pending ? "読込中…" : "表示"}
      </button>
      {(search.keyword || search.date || search.memoId) && (
        <button
          type="button"
          className="fog-text-button"
          disabled={pending}
          onClick={() => {
            setKeyword("");
            setDate("");
            startTransition(async () => {
              await router.navigate({ to: "/timeline", search: {} });
            });
          }}
        >
          解除
        </button>
      )}
    </form>
  );
}
