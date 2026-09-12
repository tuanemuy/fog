# PH-10 Verify 補助: search.md 抜き取り再実行

- 対象 HEAD: `de888b7`、環境 dev http://localhost:3000、agent-browser session `v10-sd`（TC-23 のタブ B は `v10-sd2`）
- 開始: 2026-09-11T14:13+09:00
- スクリーンショット: `/private/tmp/claude-501/-Users-hikaru-github-com-tuanemuy-fog/dd13c819-2fe3-40f6-8885-afaf8719e7bd/scratchpad/v10/sd/`

## 集計

- 合格 10 / 不合格 0 / 実行不能 0（実行: TC-01, TC-04, TC-05, TC-06, TC-07, TC-11, TC-22, TC-20, TC-14, TC-23）
- 使用ユーザー: `ph10-search-main@example.com`（Implementer が 12:04〜12:10 に作った事前準備データをそのまま使用。TC-01 の結果で M1・M2・D-A1・D-B1・D-C1 がそろい、P-12 に M3・D-B2・TP-D + D-D1 があることを確認）。自分で作ったデータ: メモ `fogfresh 反映確認メモ\nfogfresh 追記した本文`（`01a08ee5-4e9e-…`、ゴミ箱内）、トピック `検索テストE-v10`（`01a08ee7-928e-…`、ゴミ箱内）
- c844897 の修正確認: 選択中チップだけが `aria-current="page"` + `fog-chip active`（背景 `oklch(0.63 0.13 292)`・白文字）になり、`すべて` と同時に current になることは無かった（`?q=fogsearch` / `&topic=A` / `&topic=B` / `&topic=C` の 4 状態で観測、スクリーンショットで塗りを目視）。未知トピックの `?topic=` では current が 1 つも無い
- 観察: TC-23 手順3 で、開いたままのチップ `検索テストE-v10` を押した遷移の時点でチップ一覧が再取得され E-v10 が消える（押下自体は `?topic=` への遷移として成立し、その後の検索で「見つかりません」表示になるので手順書の期待は満たす）

## 結果

| TC | 判定 | 時刻 | ユーザー | 観測 |
|---|---|---|---|---|
| TC-01 | 合格 | 2026-09-11T14:14:17+09:00 | ph10-search-main（既存データ。事前準備は Implementer が 12:04〜12:10 に作成したもの） | `/search` 直後の main は `キーワードを入力すると、メモとドキュメントを横断して検索します。` のみで結果なし。`fogsearch` + Enter → `/search?q=fogsearch`。MutationObserver で `[aria-busy=true]` の `.fog-search-results`（ローディング）を観測 → `5件`: メモ `fogsearch 検索Aの出典メモ`(M2, `/?memo=01a08e6c-8712-…`) / `fogsearch 横断検索用の単独メモ`(M1) / ドキュメント `検索C資料 fogsearch 検索Cの資料本文`(D-C1, 検索テストC) / `検索B資料 …`(D-B1, 検索テストB) / `検索A資料 fogsearch 検索Aの資料本文`(D-A1, 検索テストA)。各行に種別ラベル・原文スニペット・`2026/09/11 12:0x`。重複なし、ゴミ箱の M3・D-B2・D-D1 なし。スクリーンショット `sd/search-tc01.png` |
| TC-04 | 合格 | 2026-09-11T14:14:45+09:00 | ph10-search-main | 絞り込み前（`?q=fogsearch`）のチップ: `すべて` だけが `aria-current="page"` / `class="fog-chip active"` / 背景 `oklch(0.63 0.13 292)`・文字 `rgb(255,255,255)`、A・B・C は `aria-current` なし・背景 `oklch(1 0 0)`・文字 `oklch(0.38 0.008 275)`。チップ `検索テストA` 押下 → `?q=fogsearch&topic=01a08e6d-0407-…`、`2件` = M2・D-A1 のみ（M1・D-B1・D-C1・D-A2・D-A3 なし）。このとき `検索テストA` だけが `aria-current="page"` + 塗り（`oklch(0.63 0.13 292)` / 白文字）、`すべて` は `aria-current` なし・白背景（同時 current なし）。スクリーンショット `sd/search-tc04-chipA.png` で A だけ紫の塗りを目視確認 |
| TC-05 | 合格 | 2026-09-11T14:14:56+09:00 | ph10-search-main | TC-04 の状態からチップ `すべて` 押下 → `/search?q=fogsearch`、`5件`（M2・M1・D-C1・D-B1・D-A1）。current は `すべて` のみに戻り、`検索テストA` は `aria-current` なし・白背景。スクリーンショット `sd/search-tc05-all.png` |
| TC-06 | 合格 | 2026-09-11T14:15:34+09:00 | ph10-search-main | P-06（14:15:22）: 進行中は `検索テストA`（ドキュメント数 3）・`検索テストB`（1）、`完了済み（1）`（aria-expanded=false）を開くと `検索テストC ドキュメント数: 1`。`fogsearch` の結果に D-C1 `検索C資料 …`（所属 `検索テストC`）あり（TC-01）。チップに `検索テストC 完了`（完了バッジ付き）があり、押下 → `?topic=01a08e6d-1bc2-…`、`1件` = D-C1 のみ。current は C のみ（`すべて:null / A:null / B:null / C:page`、C の背景 `oklch(0.63 0.13 292)`）。スクリーンショット `sd/search-tc06-chipC.png` |
| TC-11 | 合格 | 2026-09-11T14:15:53+09:00 | ph10-search-main | P-12（14:15:41）に `fogsearch ゴミ箱行きメモ`（メモ・残り30日）と `ゴミ箱行き資料`（ドキュメント・残り30日）あり（他に `検索テストE` トピック、`fogfresh …` メモ、`検索テストD` + 子行 `検索D資料 トピックとセットで削除`）。`fogsearch` → `5件`（M2・M1・D-C1・D-B1・D-A1。M3・D-B2 なし）。チップ `検索テストB` → `?topic=01a08e6d-0fd8-…`、`1件` = D-B1 のみ（D-B2 なし）、current は B のみ。補強: `ゴミ箱行き` → `見つかりませんでした / 「ゴミ箱行き」に一致するメモ・ドキュメントはありません。` |
| TC-07 | 合格 | 2026-09-11T14:16:31+09:00 | ph10-search-main | P-04 で `fogfresh 反映確認メモ` を投稿（14:16:27、id `01a08ee5-4e9e-77d5-8f10-2e36f66105be`、タイムラインに `14:16 fogfresh 反映確認メモ`）→ 約 4 秒後（14:16:31）に `/search?q=fogfresh` で `1件` = 当該メモ（`2026/09/11 14:16`）。ゴミ箱内の旧 `fogfresh …` メモは出ない。メモの操作 → 編集で本文を `fogfresh 反映確認メモ\nfogfresh 追記した本文` にして保存（14:16:51）→ 14:16:55 に `追記した本文` で `1件`、スニペット `fogfresh 反映確認メモ fogfresh <mark>追記した本文</mark>`。本文に `反映待ち|時間をおいて|しばらく` なし。確認ポイント: 削除（確認ダイアログ `メモを削除しますか？` → 削除、14:17:10）直後 14:17:13 に `fogfresh` → `見つかりませんでした / 「fogfresh」に一致するメモ・ドキュメントはありません。`（このメモは自分で作ったものでゴミ箱内に残した） |
| TC-22 | 合格 | 2026-09-11T14:17:41+09:00 | ph10-search-main（既存の `fogpage 連番メモ 001`〜`021` の 21 件） | `/search?q=fogpage`（14:17:32）→ `21件`、表示 20 行 = 連番 021→002（新しい順）、main のボタンは `検索` と `もっと読む`。番号送り（`N ページ目`・`n / m`）は本文に無い。`もっと読む` 押下 → ボタンが `読み込み中…`（disabled）を経て消滅（MutationObserver 記録 `["検索,読み込み中…(disabled)","検索"]`）。押下後 21 行: 先頭 20 行は押下前と同じ DOM ノードのまま（置き換えなし）、末尾に 001 が追加、連番 21 種すべて 1 回ずつ（重複・欠落なし）、URL は `?q=fogpage` のまま。スクリーンショット `sd/search-tc22-page1.png` / `sd/search-tc22-page2.png` |
| TC-20 | 合格 | 2026-09-11T14:18:05+09:00 | ph10-search-main | `fog123`（半角）→ `1件` M6 `全角表記の ｆｏｇ１２３ を含むメモ`。`<mark>` の中身は `ｆｏｇ１２３`（U+FF46 FF4F FF47 FF11 FF12 FF13 = 全角の原文のまま）。行を選択 → `/?memo=01a08e6c-9f5e-…`、ハイライトされたメモ（ビューポート内）の本文 `全角表記の ｆｏｇ１２３ を含むメモ` の該当 6 文字も同じコードポイントで一致 |
| TC-14 | 合格 | 2026-09-11T14:18:30+09:00 | ph10-search-main | `window.alert` を計数関数に差し替えてから `<script>alert(1)</script>` + Enter → `/search?q=%3Cscript%3E…`、`見つかりませんでした / 「<script>alert(1)</script>」に一致するメモ・ドキュメントはありません。`（14:18:23）。alert 呼び出し 0、main 内 script 要素 0、HTML は `&lt;script&gt;` のエスケープ済み、横スクロールなし、スクリーンショット `sd/search-tc14-script.png` でレイアウト崩れなし。`fogsearch🔍` → `?q=fogsearch%F0%9F%94%8D`、`見つかりませんでした / 「fogsearch🔍」…`、role=alert 0（エラーではない）。スクリーンショット `sd/search-tc14-emoji.png` |
| TC-23 | 合格 | 2026-09-11T14:19:49+09:00 | ph10-search-main（タブ A = `v10-sd`、タブ B = `v10-sd2` に同じユーザーでログイン） | 既存 TP-E はゴミ箱内なので、代わりに自前のトピック `検索テストE-v10`（`01a08ee7-928e-741a-8de6-3c047761e8d0`）を P-06 で作成。タブ A で `/search`（14:19:01）のチップに `検索テストE-v10`（`/search?topic=01a08ee7-…`）あり。タブ B で P-06 のトピックの操作（メニュー `編集 / 削除`）→ 削除 → ダイアログ `トピックを削除しますか？` → 削除（14:19:24）、一覧から消えゴミ箱に `検索テストE-v10 / トピック / 残り30日`。タブ A に戻り開いたままのチップ `検索テストE-v10` を押下 → `/search?topic=01a08ee7-…`（入力待ちの案内。この遷移でチップ一覧は再取得され E-v10 は消えた）→ `fogsearch` + Enter → `?q=fogsearch&topic=01a08ee7-…` に role=status `絞り込み対象のトピックが見つかりません / 削除されたか、URL のトピック ID が正しくありません。` + リンク `絞り込みを解除して検索する`（→ `/search?q=fogsearch`）。空結果表示・エラー画面ではない。このときチップはどれも `aria-current` なし。リンク押下 → `5件`（M2・M1・D-C1・D-B1・D-A1）。再読み込み後のチップは `すべて / A / B / C 完了` で E-v10 なし。スクリーンショット `sd/search-tc23-notfound.png`。`検索テストE-v10` はゴミ箱内に残した |

## 進捗ログ

- 14:13 開始。手順書と Implementer 記録を読んだ
- 14:15 TC-01 / TC-04 / TC-05 を記録（ph10-search-main の既存データを使用。データ状態は TC-01 の結果で手順書どおりと確認）
- 14:16 TC-06 / TC-11 を記録
- 14:17 TC-07 を記録
- 14:18 TC-22 を記録
- 14:19 TC-20 / TC-14 を記録。次は TC-23（自前のトピック `検索テストE-v10` を作って削除する）
- 14:20 TC-23 を記録。search.md の抜き取りはここまで（10 ケース）
- 14:31 完了。ブラウザセッション v10-sd / v10-sd2 を close
