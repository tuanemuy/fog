"use client";

import type { TimelineItemView } from "@repo/core/application/memo/view";
import { snippetOf } from "@repo/core/lib/text";
import { useServerFn } from "@tanstack/react-start";
import {
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
  useTransition,
} from "react";
import { loadTimelinePageFn } from "@/components/timeline/actions";
import { isTimelinePageResult } from "@/components/timeline/schema";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Row } from "@/components/ui/Row";
import { RowList } from "@/components/ui/RowList";
import { SearchPill } from "@/components/ui/SearchPill";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { SourceMemoLine } from "../SourceMemoLine";

/** A memo chosen as a source, as the editor keeps it until the save. */
export type PickedMemo = Readonly<{
  memoId: string;
  snippet: string;
  postedAt: Date;
}>;

/** How many candidates one search shows. */
export const PICKER_PAGE_LIMIT = 20;

/**
 * P-09's source-memo picker (`spec/design/pages/document-edit.html`, 出典の
 * 検索と選択): 「出典を追加」 turns into the search box in its place, which
 * lists the most recent memos at once and a keyword's matches on Enter — the
 * timeline's keyword filter re-used as the search (a substring match over
 * the user's own memos, 20 at most). Only active memos come back,
 * so the trash never offers itself as a source. Closing the box brings the
 * button back.
 */
export function SourceMemoPicker({
  picked,
  onPick,
}: {
  picked: readonly PickedMemo[];
  onPick: (memo: PickedMemo) => void;
}) {
  const fetchPage = useServerFn(loadTimelinePageFn);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<TimelineItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const pickedIds = new Set(picked.map((memo) => memo.memoId));

  // The focus follows the swap both ways: into the box that replaced the
  // button, and back onto the button when the box closes — but not onto the
  // button as the editor first draws it.
  const returnFocus = useRef(false);
  const focusInput = useCallback((node: HTMLInputElement | null) => {
    node?.focus();
  }, []);
  const focusButton = useCallback((node: HTMLButtonElement | null) => {
    if (node === null || !returnFocus.current) return;
    returnFocus.current = false;
    node.focus();
  }, []);

  const search = (keyword: string) => {
    const trimmed = keyword.trim();
    setError(null);
    startSearch(async () => {
      try {
        const page = readServerFnResult(
          await fetchPage({
            data: {
              cursor: null,
              direction: "older",
              limit: PICKER_PAGE_LIMIT,
              keyword: trimmed.length > 0 ? trimmed : null,
            },
          }),
          isTimelinePageResult,
          "loadTimelinePageFn",
        );
        setCandidates([...page.items]);
      } catch (failure) {
        setError(displayError(failure));
      }
    });
  };

  // Not a <form>: the picker sits inside the editor's form, and a form may
  // not nest another. Enter searches instead of saving the document, except
  // while an input method is still composing the word.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!searching) search(query);
  };

  if (!open) {
    return (
      <div className="mt-md">
        <Button
          ref={focusButton}
          variant="outline"
          onClick={() => {
            setOpen(true);
            search("");
          }}
        >
          <Icon name="plus" size="xs" />
          出典を追加
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-md">
      <SearchPill
        label="メモを検索"
        placeholder="メモを検索"
        type="text"
        value={query}
        ref={focusInput}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      >
        <IconButton
          icon="close"
          label="検索を閉じる"
          size="sm"
          placement="row"
          onClick={() => {
            returnFocus.current = true;
            setOpen(false);
            setQuery("");
            setCandidates(null);
            setError(null);
          }}
        />
      </SearchPill>
      <div className="mt-sm" aria-busy={searching || undefined}>
        {error !== null ? (
          <InlineAlert
            tone="error"
            retry={{ label: "再試行", onRetry: () => search(query) }}
          >
            {error}
          </InlineAlert>
        ) : candidates === null ? null : candidates.length === 0 ? (
          <EmptyState message="一致するメモはありません" />
        ) : (
          <RowList aria-label="候補のメモ">
            {candidates.map((memo) => {
              const added = pickedIds.has(memo.id);
              return (
                <li key={memo.id}>
                  <Row
                    actions={
                      <IconButton
                        icon={added ? "check" : "plus"}
                        label={added ? "出典に追加済み" : "出典に追加"}
                        size="sm"
                        placement="row"
                        tone="primary"
                        disabled={added}
                        onClick={() =>
                          onPick({
                            memoId: memo.id,
                            snippet: snippetOf(memo.body),
                            postedAt: memo.postedAt,
                          })
                        }
                      />
                    }
                  >
                    <SourceMemoLine
                      postedAt={memo.postedAt}
                      snippet={snippetOf(memo.body)}
                    />
                  </Row>
                </li>
              );
            })}
          </RowList>
        )}
      </div>
    </div>
  );
}
