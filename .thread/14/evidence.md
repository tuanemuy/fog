# 根拠の記録 — Issue #14

証跡のパスは `/private/tmp/claude-501/-Users-hikaru-github-com-tuanemuy-dotfiles-agents-skills/c8c03944-c01b-4c6e-a71d-35b79645f865/scratchpad/cmp/wt/fog-14-OLD.evidence/` からの相対パス。観測は `pnpm dev`（ポート 6860）と agent-browser で、すべて今のツリー（ADR-002 の実装）に対して行った。

観測の記録の取り方: 編集の前に `window.__mark` を置き（残っていれば再読み込みしていない）、MutationObserver で行の本文と日付見出しの並びが変わるたびに記録した（`[編集中]` はエディタを開いている行）。

## 再現（変更前）

`/?q=りんご` に「りんご を買う」「りんご ジュース」を出し、「りんご ジュース」を「みかん ジュース」に編集して保存した。保存と再取得の後も「みかん ジュース」の行が残った（`before-fix-repro-q.png`）。再読み込みで消えた。

## AC ごとの根拠

| AC | 満たすコード | 自動テスト（`timelineBoard.dom.test.tsx`） | 観測 |
|---|---|---|---|
| AC-1 | `pruneToWindow`、窓を受け取ったときの刈り込み（`prunedFor`） | 「shows the saved body until the refetched window arrives, then drops the memo it no longer carries」 | 1280px `/?q=桃`: 「桃 1」→「メロン 1」。記録: `桃 4 / 桃 3 / 桃 2 / 桃 1` → `… / [編集中]` → `… / メロン 1` → `桃 4 / 桃 3 / 桃 2`。`__mark` 残存（`AC-1-1280.png`、`AC-1-1280.webm`）。375px: 「桃 2 改」→「メロン 2」。記録: `桃 4 改 / 桃 2 改` → `… / [編集中]` → `… / メロン 2` → `桃 4 改`。`__mark` 残存、`scrollWidth` 375（`AC-1-375.png`、`AC-1-375.webm`） |
| AC-1b | 同上、`windowCovers` | 「drops it when a scrolled-in page carries it too, and keeps the scrolled-in rows past the window」、`windowCovers` の 4 件、`pruneToWindow` の 1 件 | 1280px `/?q=梨`（51 件の一致）: 最下部まで読み込んで 51 件、末尾 `梨 05|梨 04|梨 02`。「梨 新B」を外すと 50 件で末尾 `梨 05|梨 04|梨 02`（窓が下にずれ、「梨 02」が窓と読み込んだページの両方に入る）。「梨 02」を外すと 49 件で末尾 `梨 06|梨 05|梨 04`。`__mark` 残存（`AC-1b-1280.png`） |
| AC-1c | 刈り込みを窓の受け取りごとに 1 回、状態に対して行う | 「keeps a dropped row gone when a later window no longer reaches it」 | 1280px `/?q=梨`（53 件の一致を読み込んだ後）: 「梨 52」を外し、窓に入った「梨 01」を外した後、別のタブで「梨 新A」「梨 新B」を投稿し、この画面で「梨 51」を一致したまま編集した。窓は 50 件で末尾「梨 04」（古い側のカーソルあり）になり、「梨 01」は一覧に無い（`__mark` 残存、`AC-1b-stays-gone-1280.png`）。途中の手順の件数の記録はシェルの誤りで取れず、最後の状態だけを記録した。このとき「梨 02」（窓にだけあり、読み込んだページに無かった）も消えた。これは変更前のツリーにもある継ぎ目の破れ（起票の下書き 2.）で、刈り込みとは別 |
| AC-2 | 同上 | 「drops it under a date jump with a keyword too, noting the day once its last match is gone」（リポジトリが返す形の窓: 着地点が新しい側の端なら `newerCursor` は null） | 1280px `/?date=2026-11-20&q=桃`: 「桃 3」→「メロン 3」。記録: `桃 4 / 桃 3 / 桃 2 改` → `… / メロン 3 / …` → `桃 4 / 桃 2 改`。`__mark` 残存（`AC-2-1280.png`）。着地点が外れる場合: ローカルの DO の SQLite で「柿 昨日」の `posted_at` を 1 日前（2026-11-19）に移し、`/?date=2026-11-20&q=柿` で唯一の一致「柿 今日」を「林檎 今日」にした。記録: `柿 今日 / 柿 昨日 # 2026年11月20日(金) | 2026年11月19日(木)` → `林檎 今日 / 柿 昨日 # …` → `柿 昨日 # 2026年11月19日(木)2026年11月20日(金)のメモはありません`。`__mark` 残存（`AC-2-landing-1280.png`、`AC-2-landing-1280.webm`）。同じ URL の再読み込み（`AC-2-landing-1280-reload.png`）と同じ見出しと行 |
| AC-3 | `mergeTimeline`（版の大きいほうが勝つ） | 「keeps the edited memo with its saved body while the refetched window still carries it」 | 1280px: 「桃 2」→「桃 2 改」。記録: `… / 桃 2` → `… / [編集中]` → `… / 桃 2 改` で終わる（`AC-3-1280.png`） |
| AC-4 | 既存の `EmptyState` の分岐 | 「shows the no-match state once the last match is edited away」 | 375px `/?q=栗`: 唯一の「栗」を「マロン」にすると、記録 `栗` → `[編集中]` → `マロン` → 行なし。「「栗」に一致するメモは見つかりませんでした」と「絞り込みを解除」が出る（`AC-4-375.png`、`AC-4-375.webm`）。既存の 0 件表示（`/?q=zz存在しないzz`、`compare-no-match-375.png`）と同じ構造 |
| AC-5 | `onSaved`（変更なし）と `mergeTimeline` | 「shows the saved body once the save settles, before the refetched window arrives, and after it」 | 1280px `/`: 「桃 4」→「桃 4 改」。記録: `栗 / 桃 4 / …` → `栗 / [編集中] / …` → `栗 / 桃 4 改 / …` で終わり、「桃 4」に戻る記録は無い（`AC-5-1280.png`、`AC-5-1280.webm`） |
| AC-6 | 同上 | 「keeps a scrolled-in row with its saved body, since its page is not refetched」 | — |
| AC-7 | `docs/frontend_implementation_example.md`、`docs/test.md`、`windowCovers`・`pruneToWindow`・刈り込みの JSDoc とコメント | — | 差分の読み |
| AC-8 | — | — | `pnpm typecheck`・`pnpm lint`・`pnpm format:check` がいずれも終了コード 0（`pnpm lint` の警告 1 件は `apps/web/app/worker/cloudflare/__tests__/wranglerConfig.test.ts:471` の既存のもの）。`pnpm exec vitest run --project dom`: 55 ファイル・457 件すべて通過 |

観測のエッジケース: 375px で `document.documentElement.scrollWidth` は 375（横スクロールなし）。ブラウザのコンソールにエラー・警告なし。

## 変異（すべて元に戻した）

| 変異 | 赤になったテスト |
|---|---|
| 窓を受け取ったときの刈り込みを外す | AC-1／AC-1b／AC-1c／AC-2／AC-4 の 5 件 |
| 刈り込みを外し、描画のたびに今の窓で `loaded` を絞る（ADR-001 の形） | keeps a dropped row gone when a later window no longer reaches it |
| `pruneToWindow` の `carried.has(row.id) ||` を外す | pruneToWindow の単体／keeps a dropped row gone（窓が運んでいた「c」が後の窓の外で消える） |
| `windowCovers` の新しい側の端を常に範囲内にする | stops at an end that has a cursor… |
| `windowCovers` の古い側の端を常に範囲内にする | 5 件 |
| `windowCovers` の古い側の端を、端を含まないようにする | covers what lies between… ends included |
| `windowCovers` の新しい側の端を、端を含まないようにする | 同上 |
| 空の窓を常に範囲外にする | covers everything when empty…／no-match state |
| 新しい側の端をカーソルの有無によらず閉じる | 5 件 |
| 古い側の端をカーソルの有無によらず閉じる | stops at an end that has a cursor… |

## 変更が届く箇所

| 届く箇所 | 確かめ方 |
|---|---|
| `loaded` を読む `base`（`mergeTimeline(initial.items, loaded)`）→ `useOptimistic`（投稿の楽観的な追加・削除の楽観的な取り除き） | 投稿・削除の既存 DOM テストが通過 |
| `loaded` を書く `loadMore`（`setLoaded((current) => mergeTimeline(current, result.items))`）。刈り込みと同じ描画の後に届いても、更新関数で積むので刈り込みを打ち消さない | 無限スクロールの既存 DOM テストが通過、AC-1b・AC-1c のテスト（読み込み後に刈り込み） |
| `loaded` を書く `onSaved`（変更なし）と `runDelete` の `setLoaded` のフィルタ | AC-1〜AC-6 のテスト、削除の既存 DOM テストが通過 |
| `pivot`／`missingDayNote`（`optimistic` から着地点を探す）、着地点へのスクロールの副作用 | 日付ジャンプの既存 DOM テストと AC-2 のテスト・観測 |
| 空状態の分岐（`optimistic.length === 0`） | AC-4 のテストと観測 |
| 位置指定の表示（`target`）。`?memo=` はキーワードを持たないので、編集で窓から外れる行は無い | 既存の DOM テストが通過 |
| 投稿後の再取得（絞り込みなしの `router.invalidate()`、絞り込み中は `goto({})` で island を作り直す） | 投稿の既存 DOM テストが通過。実機で、投稿後に窓の末尾の行が消える既存の破れを確かめ、変更前のツリーでも同じだった（起票の下書き 2.） |

## 確かめた既存の破れ（スコープ外）

- 絞り込みなしで過去のページを読み込んだ後に投稿すると、投稿前の窓の末尾（50 件目）が一覧から消える。変更前のツリー（`TimelineBoard` を `619769c` の版に戻した状態）でも、同じ手順で 1 件消えた。AC-1c の観測で「梨 02」が消えたのも同じ継ぎ目の破れ。起票の下書き 2.
