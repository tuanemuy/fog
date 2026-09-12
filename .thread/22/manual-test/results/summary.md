# テスト実行サマリー

**実行日時**: 2026-09-12（観測）／判定は同日
**テストソース**: `.thread/22/testing.md`
**観測ログ**: `.thread/22/manual-test/logs/`（`00-run-info.md` ＋ 24 ファイル）
**サーバー**: <http://localhost:3000>（`pnpm dev`）
**ビューポート**: モバイル 390×844 ／ `lg` 1280×900
**証跡**: 46 ファイル（各項目の `.png` / `.webm`。R-2 のみ証跡なし＝`curl` 観測）

| TC | テスト名 | 種別 | 結果 | 三分 | 失敗ステップ |
|----|---------|------|------|------|-------------|
| TC-01 | 戻る付きヘッダーの英語タイトル | 正常系 | PASS | - | - |
| TC-02 | 共通シェル | 正常系 | FAIL | 手順書起因 | Step 6 / 10 |
| TC-03 | モバイルのボトムシート | 正常系 | FAIL | 手順書起因 | Step 4 |
| TC-04 | 基準形のプリミティブ | 正常系 | FAIL | 手順書起因 | Step 5 |
| TC-05 | コンポーザー | 正常系 | PASS | - | - |
| TC-06 | 成功・一度きりの通知のトースト | 正常系 | PASS | - | - |
| TC-07 | エラーの持ち場 | 異常系 | FAIL | 手順書起因 | Step 6 |
| TC-08 | スケルトン | 正常系 | FAIL | 手順書起因 | Step 3 / 4b / 7 |
| TC-09 | ルートエラーと 404 | 異常系 | PASS | - | - |
| TC-10 | 認証シートの 5 画面 | 正常系 | PASS | - | - |
| TC-11 | 行・空状態・フォームの基準形 | 正常系 | FAIL | 手順書起因 | Step 12 |
| TC-12 | ゴミ箱と設定 | 正常系 | PASS | - | - |
| E-1 | トーストの重なり | 異常系 | PASS | - | - |
| E-2 | メモ不在の位置指定遷移 | 異常系 | PASS | - | - |
| E-3 | 検索の絞り込みトピック不在 | 異常系 | PASS | - | - |
| E-4 | 二重送信と空送信 | 異常系 | PASS | - | - |
| E-5 | `lg` でモバイル部品が出ない | 正常系 | FAIL | 手順書起因 | Step 3 |
| E-6 | キーボード操作 | 正常系 | PASS | - | - |
| E-7 | 長いタイトル・長い本文 | 異常系 | PASS | - | - |
| R-1 | 5 画面の URL | 回帰 | PASS | - | - |
| R-2 | `Cache-Control: no-store` | 回帰 | PASS | - | - |
| R-3 | シートのスクロール | 回帰 | PASS | - | - |
| R-4 | 基本フロー | 回帰 | PASS | - | - |
| R-5 | 撤去された導線 | 回帰 | PASS | - | - |

**合計**: 24 件（PASS: 17 / FAIL: 7）
**FAIL の内訳**: 手順書起因 7 ／ 変更起因 0 ／ 変更と無関係 0

## FAIL の根拠（1 行ずつ）

| TC | 根拠 |
|----|------|
| TC-02 | 現在地の丸は `tokens.md`「選択マーク＝`--color-primary`」とモック `.side-link[aria-current] .mark` どおりで橙ではなく、タイトル左端と本文左端が揃うのもモックでは 768px 以上の共有カラムでの話 |
| TC-03 | 同じく `.nav-item[aria-current="page"] .mark` は `--color-primary`。`--color-accent` はロゴ点と戻る付きヘッダーのドット専用（tokens.md） |
| TC-04 | トピック一覧の行はモック `topics.html` の `.row-main`（ボタン行・矢印なし・ホバー面なし）どおりで、矢印を持つ行の色も `document.html .o-jump` の primary |
| TC-07 | 保持期限 `0` は `min="1"`（モック `settings.html` も同じ属性）のネイティブ検証で送信が止まり、`FieldError`「1以上の日数を入力してください」に到達しない（実装側の経路は `retentionForm.dom.test.tsx` が担保） |
| TC-08 | spec の規定は「実 DOM に被せ、文字を透明にして同じ行高を保つ」までで行数の一致は求めず、`/search` の読み上げも `LoadingRow` の `role="status"` が 1 か所で持つ |
| TC-11 | 出典 0 件で領域を出さないのは `spec/pages/index.md` P-08 とモックの状態例どおり、ヘッダーの「削除」もモック `document.html` で `icon-btn`（中立色） |
| E-5 | TC-02・TC-03 と同根で、サイドバーの現在地マークは `--color-primary` |

## 未観測（FAIL ではない）

| 項目 | 理由 | 他の担保 |
|---|---|---|
| TC-11 タイムラインの空状態 | メモを全消しせずに再現できない | `timeline/__tests__/timelineBoard.dom.test.tsx` |
| TC-12 行の `RowError` と語「リトライ」 | 行の操作失敗を再現できない | `trash/__tests__/trashBoard.dom.test.tsx` |
| TC-12 `復元中…` / 空のゴミ箱の表示 | この手順では捉えられず | E-1 で観測済み |
| TC-06 成功と部分失敗の混在 | testing.md の指示により対象外 | `trashBoard.dom.test.tsx`・`aiConnectionsPanel.dom.test.tsx` |
| TC-09 レイアウトルート自身の失敗・シェル内 404 | ブラウザから起こせない | `layout/__tests__/routeBoundaries.dom.test.tsx` |
| TC-08 SSR ストリーミング経路 | `pnpm dev` では `ssr: !import.meta.env.DEV` で無効、`pnpm preview` は `.wrangler/state` を共有するため併用せず | クライアント側ローダー経路のスケルトンのみ観測 |
| TC-03 背面スクロール抑止 | `/topics` の中身が 1 画面に収まり切り分け不可 | `dialog` が `:modal` であることは観測済み |
| TC-07 再試行の語の出し分け | 再試行を伴う失敗を起こしていない | E-1 で面の `InlineAlert` を観測 |
| R-3 下端での過去メモ自動読み込み | メモ 10 件が 1 ページに収まり番兵が発火しない | ボタンが無いこと（ADR-037）は確認済み |

## 判定時に併せて記録した観測事実

- dev サーバーのログに React の警告が 1 件（13:45:02、TC-06 の時間帯）: `Can't perform a React state update on a component that hasn't mounted yet.` — 期待結果は満たされており FAIL 要因ではないが、変更範囲（トースト周辺）で出ているため追跡の価値がある。
- `R-4` の「この内容に戻す」には確認ダイアログが 1 段挟まる。spec / モックどおりで、testing.md の手順に記載が無いだけ。
- E-1 の「ゴミ箱に見つかりません」は行の下（`RowError`）ではなく一覧の面（`InlineAlert`、`retryLabel: "一覧を読み直す"`）に出る。ADR-034 の「行＝リトライ／面＝再試行」とは別の持ち場の文言。
