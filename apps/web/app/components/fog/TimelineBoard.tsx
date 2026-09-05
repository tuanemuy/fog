"use client";

import type { MemoView, TimelinePage } from "@repo/core/application/fog/types";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  useActionState,
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { displayError } from "@/presentation/errorDisplay";
import { createFogMemo } from "@/presentation/fogActions";
import { deleteFogContent } from "@/presentation/fogDataActions";
import { loadFogTimeline } from "@/presentation/fogMemoActions";
import type { TimelineSearch } from "@/presentation/fogTimelineSchema";
import { ConfirmDialog } from "./ConfirmDialog";
import { MemoItem } from "./MemoItem";
import { TimelineFilters } from "./TimelineFilters";

const dayFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
  timeZone: "Asia/Tokyo",
});
type DisplayMemo = MemoView & { pending?: boolean };
export function TimelineBoard({
  page,
  search,
}: {
  page: TimelinePage;
  search: TimelineSearch;
}) {
  const router = useRouter();
  const create = useServerFn(createFogMemo);
  const remove = useServerFn(deleteFogContent);
  const [removing, setRemoving] = useState<MemoView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const fetchPage = useServerFn(loadFogTimeline);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<MemoView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const unique = new Map(
    [...loaded, ...page.memos].map((memo) => [memo.id, memo]),
  );
  const base = [...unique.values()]
    .filter(
      (memo) =>
        search.memoId ||
        !search.keyword ||
        memo.body
          .toLocaleLowerCase()
          .includes(search.keyword.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const next = cursor === undefined ? page.nextCursor : cursor;
  const [optimistic, addOptimistic] = useOptimistic<
    DisplayMemo[],
    { kind: "add"; memo: DisplayMemo } | { kind: "remove"; id: string }
  >(base, (current, change) =>
    change.kind === "add"
      ? [change.memo, ...current]
      : current.filter((memo) => memo.id !== change.id),
  );
  const loadNext = useCallback(() => {
    if (!next || busy.current) return;
    busy.current = true;
    startLoad(async () => {
      try {
        const result = await fetchPage({
          data: { ...search, cursor: next, limit: 30 },
        });
        setLoaded((current) => [
          ...new Map(
            [...current, ...page.memos, ...result.memos].map((memo) => [
              memo.id,
              memo,
            ]),
          ).values(),
        ]);
        setCursor(result.nextCursor);
        setLoadError(null);
      } catch (failure) {
        setLoadError(displayError(failure));
      } finally {
        busy.current = false;
      }
    });
  }, [next, fetchPage, search, page.memos]);
  useEffect(() => {
    if (!next || loadError || loading || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNext();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [next, loadError, loading, loadNext]);
  useEffect(() => {
    if (page.focusId)
      document
        .getElementById(`memo-${page.focusId}`)
        ?.scrollIntoView({ block: "center" });
  }, [page.focusId]);
  const [state, action, pending] = useActionState<
    { error: string | null; saved: boolean },
    FormData
  >(
    async () => {
      const body = draft;
      if (!body.trim())
        return { error: "メモを入力してください。", saved: false };
      const now = new Date().toISOString();
      addOptimistic({
        kind: "add",
        memo: {
          id: `pending-${crypto.randomUUID()}`,
          body,
          createdAt: now,
          updatedAt: now,
          version: 0,
          sourceDocuments: [],
          pending: true,
        },
      });
      try {
        await create({ data: { body } });
        await router.invalidate();
        setDraft("");
        return { error: null, saved: true };
      } catch (failure) {
        return { error: displayError(failure), saved: false };
      }
    },
    { error: null, saved: false },
  );
  const groups = new Map<string, DisplayMemo[]>();
  for (const memo of optimistic) {
    const day = dayFormatter.format(new Date(memo.createdAt));
    groups.set(day, [...(groups.get(day) ?? []), memo]);
  }
  return (
    <section
      className="fog-timeline"
      aria-label="メモ一覧"
      aria-busy={pending || loading}
    >
      <TimelineFilters key={JSON.stringify(search)} search={search} />
      {search.date && (
        <p className="fog-hint">{search.date} に近いメモから表示しています。</p>
      )}
      {optimistic.length === 0 ? (
        <div className="fog-empty">
          <span className="fog-empty-mark" aria-hidden="true">
            ＋
          </span>
          <h2>
            {search.keyword || search.date || search.memoId
              ? "メモが見つかりませんでした"
              : "最初のメモを残そう"}
          </h2>
          <p>
            {search.keyword || search.date || search.memoId
              ? "絞り込みを解除して、もう一度お試しください。"
              : "思いつきも、今日の出来事も。下の入力欄から気軽に書き留めてください。"}
          </p>
        </div>
      ) : (
        Array.from(groups, ([day, entries]) => (
          <section className="fog-day" key={day}>
            <h2>{day}</h2>
            {entries.map((memo) => (
              <MemoItem
                key={memo.id}
                memo={memo}
                onDelete={(target) => {
                  setDeleteError(null);
                  setRemoving(target);
                }}
                onSaved={(saved) =>
                  setLoaded((current) =>
                    current.map((entry) =>
                      entry.id === saved.id ? saved : entry,
                    ),
                  )
                }
              />
            ))}
          </section>
        ))
      )}
      {loadError && (
        <p className="fog-error" role="alert">
          {loadError}
        </p>
      )}
      <div ref={sentinel} className="fog-load-more">
        {next && (
          <button
            type="button"
            className="fog-secondary"
            onClick={loadNext}
            disabled={loading}
          >
            {loading
              ? "読込中…"
              : loadError
                ? "もう一度読み込む"
                : "もっと読む"}
          </button>
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title="メモをゴミ箱に移しますか？"
          pending={deleting}
          onCancel={() => setRemoving(null)}
        >
          <p className="fog-source-text">{removing.body}</p>
          <p>保持期限内なら、元の位置へ復元できます。</p>
          {deleteError && (
            <p className="fog-error" role="alert">
              {deleteError}
            </p>
          )}
          <button
            type="button"
            className="fog-primary"
            disabled={deleting}
            onClick={() =>
              startDelete(async () => {
                const target = removing;
                addOptimistic({ kind: "remove", id: target.id });
                try {
                  await remove({
                    data: {
                      kind: "memo",
                      id: target.id,
                      expectedVersion: target.version,
                    },
                  });
                  setLoaded((current) =>
                    current.filter((memo) => memo.id !== target.id),
                  );
                  if (search.memoId === target.id)
                    await router.navigate({ to: "/timeline", search: {} });
                  await router.invalidate();
                  setRemoving(null);
                } catch (failure) {
                  setDeleteError(displayError(failure));
                }
              })
            }
          >
            {deleting ? "移動中…" : "ゴミ箱に移す"}
          </button>
        </ConfirmDialog>
      )}
      <div className="fog-composer-wrap">
        <form action={action} className="fog-composer" aria-label="メモを投稿">
          <label className="fog-sr-only" htmlFor="memo-body">
            メモを入力
          </label>
          <textarea
            id="memo-body"
            name="body"
            placeholder="メモを入力…"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={100000}
            disabled={pending}
            aria-describedby={state.error ? "memo-error" : undefined}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            type="submit"
            className="fog-primary"
            disabled={pending || !draft.trim()}
          >
            {pending ? "保存中…" : "投稿"}
          </button>
          {state.error && (
            <p id="memo-error" role="alert" className="fog-error">
              {state.error}
            </p>
          )}
          <span className="fog-sr-only" role="status">
            {state.saved && !pending ? "メモを保存しました" : ""}
          </span>
        </form>
      </div>
    </section>
  );
}
