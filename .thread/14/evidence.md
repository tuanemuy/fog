# 根拠の記録 — Issue #14

証跡のパスは `/private/tmp/claude-501/-Users-hikaru-github-com-tuanemuy-dotfiles-agents-skills/c8c03944-c01b-4c6e-a71d-35b79645f865/scratchpad/cmp/wt/fog-14-OLD.evidence/` からの相対パス。

## 再現（変更前）

`pnpm dev`（ポート 6860）で、`/?q=りんご` に「りんご を買う」「りんご ジュース」を出し、「りんご ジュース」を「みかん ジュース」に編集して保存した。保存と再取得の後も「みかん ジュース」の行が残った（`before-fix-repro-q.png`）。再読み込みで消えた。

## AC ごとの根拠

| AC | 満たすコード | 自動テスト（`timelineBoard.dom.test.tsx`） | 観測（`pnpm dev`、agent-browser） |
|---|---|---|---|
| AC-1 | `applySaved`（行を足さない）、`timelineRows` | 「shows the saved body until the refetched window arrives, then drops the memo it no longer carries」 | 1280px: `/?q=りんご` で「りんご 1」→「メロン 1」。行が消え、ほかの 5 件が残る。URL は同じ（`AC-1-1280.png`、`AC-1-1280.webm`）。375px: 「りんご 4」→「メロン 4」。行が消え、2 件が残る。`window.__mark` が残り、再読み込みしていない（`AC-1-375.png`、`AC-1-375.webm`） |
| AC-1b | `windowCovers`、`timelineRows` | 「drops it when a scrolled-in page carries it too, and keeps the scrolled-in rows past the window」、`windowCovers` の 4 件、`timelineRows` の 2 件 | 1280px: 「梨 01」〜「梨 53」で `/?q=梨` を開き、最下部まで読み込んで 53 件。「梨 53」を外すと 52 件（窓が下にずれ「梨 03」が窓と読み込んだページの両方に入る）。続けて「梨 03」を外すと 51 件で、末尾は「梨 04・梨 02・梨 01」。再読み込みなし（`AC-1b-1280.png`） |
| AC-2 | 同上 | 「drops it under a date jump with a keyword too, noting the day once its last match is gone」（A が着地点で窓の新しい側の端、再取得後の見出しの注記） | 1280px: `/?date=2026-11-20&q=りんご` で「りんご 3」「りんご を買う」を外すと、それぞれ行が消え、残りが残る。再読み込みなし（`AC-2-1280.png`、`AC-2-1280-b.png`）。着地点が別の日に移る場合は、メモの投稿日時を選べないため実機では作れず、DOM テストだけで確かめた |
| AC-3 | `applySaved` | 「keeps the edited memo with its saved body while the refetched window still carries it」 | 1280px: 「りんご 2」→「りんご 2 改」。行が残り、新しい本文を出す。再読み込みなし（`AC-3-1280.png`） |
| AC-4 | 既存の `EmptyState` の分岐 | 「shows the no-match state once the last match is edited away」 | 375px: `/?q=ぶどう` で唯一の「ぶどう」を「メロン 六」にすると、「「ぶどう」に一致するメモは見つかりませんでした」と「絞り込みを解除」が出る（`AC-4-375.png`、`AC-4-375.webm`）。既存の 0 件表示（`/?q=zz存在しないzz`、`compare-no-match-375.png`）と同じ構造 |
| AC-5 | `applySaved` | 「shows the saved body once the save settles, before the refetched window arrives, and after it」 | 1280px: `/` で「バナナ を買う」→「バナナ を2本買う」。再取得後に新しい本文を出す（`AC-5-1280.png`）。再取得前の一瞬は実機では切り出せず、DOM テストで確かめた |
| AC-6 | `applySaved` | 「keeps a scrolled-in row with its saved body, since its page is not refetched」 | — |
| AC-7 | `docs/frontend_implementation_example.md`、`docs/test.md`、`mergeTimeline`・`windowCovers`・`timelineRows`・`applySaved` の JSDoc、`MemoEntry` の `onSaved` の JSDoc | — | 差分の読み |
| AC-8 | — | — | `pnpm typecheck`・`pnpm lint`・`pnpm format:check` がいずれも終了コード 0（`pnpm lint` の警告 1 件は `apps/web/app/worker/cloudflare/__tests__/wranglerConfig.test.ts:471` の既存のもの）。`pnpm exec vitest run --project dom`: 55 ファイル・460 件すべて通過 |

観測のエッジケース: 375px で `document.documentElement.scrollWidth` は 375（横スクロールなし）。ブラウザのコンソールにエラーなし。

## 変異（すべて赤を確認し、元に戻した）

| 変異 | 赤になったテスト |
|---|---|
| `onSaved` を元の「`loaded` に足す」に戻す | date jump with a keyword（着地点が窓の端） |
| `base` から `applySaved` を外す | saved body until the refetched window arrives／before and after the refetch／scrolled-in row |
| `applySaved` の `<=` を `<`（同じ版で保存結果が勝つ） | keeps the row when it is as new as the save or newer |
| `applySaved` が行に無い保存結果を足す | never adds a row／drops the edited memo の 3 件 |
| `applySaved` が保存結果のある行を落とす | 6 件 |
| `base` から `timelineRows` を外す（`mergeTimeline` に戻す） | drops it when a scrolled-in page carries it too |
| `timelineRows` の `carried.has(row.id) ||` を外す | keeps the higher version of a row both carry |
| `windowCovers` の新しい側の端を常に範囲内にする | stops at an end that has a cursor…／newer page の 2 件 |
| `windowCovers` の古い側の端を常に範囲内にする | 8 件 |
| `windowCovers` の古い側の端を両端を含まないようにする | covers what lies between… ends included |
| 空の窓を常に範囲外にする | covers everything when empty with no cursors |
| `windowCovers` の新しい側の端をカーソルの有無によらず閉じる | stops at an end…／breaks a tie…／drops it when a scrolled-in page carries it too |

## 変更が届く箇所

| 届く箇所 | 確かめ方 |
|---|---|
| `MemoEntry` が `onSaved` を呼ぶ（型は `(memo: MemoView) => void` のまま） | `memoEntry.dom.test.tsx` の onSaved の 2 件が通過 |
| `base` → `useOptimistic`（投稿の楽観的な追加・削除の楽観的な取り除き） | 投稿・削除の既存 DOM テストが通過 |
| `removed`（削除済みの行を外す）と `setLoaded` の削除時のフィルタ | 削除の既存 DOM テストが通過 |
| `loadMore` → `setLoaded(mergeTimeline(current, result.items))`（`mergeTimeline` は JSDoc だけ変更） | 無限スクロールの既存 DOM テストが通過、`mergeTimeline` の単体テストが通過 |
| `pivot`／`missingDayNote`（`optimistic` から着地点を探す） | 日付ジャンプの既存 DOM テストと AC-2 のテストが通過 |
| 着地点へのスクロールの副作用（`pivotId` に依存） | 日付ジャンプの既存 DOM テストが通過 |
| 空状態の分岐（`optimistic.length === 0`） | AC-4 のテストと観測 |
| 位置指定の表示（`target`） | 既存の DOM テストが通過 |
| 投稿後の再取得（絞り込みなしの `router.invalidate()`）と `windowCovers` | 投稿の既存 DOM テストが通過。実機で、投稿後に窓の末尾の行が消える既存の破れを確かめ、変更前のツリーでも同じだった（起票の下書き 2.） |

## 確かめた既存の破れ（スコープ外）

- 絞り込みなしで過去のページを読み込んだ後に投稿すると、投稿前の窓の末尾（50 件目）が一覧から消える。変更前のツリーでも同じ手順で 1 件消えた。起票の下書き 2.
