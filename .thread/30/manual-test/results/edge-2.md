# EDGE-2: エラー画面の本文がブロック幅で描画される

**結果**: PASS
**セッション**: verify-error

対応: エッジケース・異常系 2
実行日: 2026-07-26 / ビューポート: 1280x633 / 対象 URL: `http://localhost:3000/signup`（`/login` からのクライアント遷移）

## エラー画面の出し方

testing.md の「`.env` の `DATABASE_URL` を壊してサーバー再起動」は dev サーバーでは使えない。SSR が Vite のエラーオーバーレイで落ち、アプリの `ErrorScreen`（`__root.tsx` の `errorComponent`）まで到達しないため。

代わりに「サーバーを落としてからクライアントサイド遷移させる」手順を使った。

1. `http://localhost:3000/login` を開き、正常描画とベースライン余白を計測
2. dev サーバーを停止
3. ページ内の「アカウント登録」リンクをクリックしてクライアント遷移
4. ルートの `beforeLoad`（`loadAppContext`）が dev では `staleTime: 0` で毎回再実行され、サーバー関数の fetch が失敗 → `__root.tsx` の `errorComponent` = `ErrorScreen`（`AuthSheet` + `ErrorRetry fullWidth`）が描画される

補足: 指示された `pkill -f "vite dev --config vite.config.node.ts"` はプロセスにマッチしなかった（実際のコマンドラインは `.../vite/bin/vite.js dev --config vite.config.node.ts` で、`vite dev` ではなく `vite.js dev`）。該当 PID を直接 `kill` して停止を確認した（`curl` が `000` / server down）。

なお、この経路では `sanitizeRouteError` の返す文字列が `ERROR_TITLE` と一致するため `description` は付かない（`descriptionPresent: false`）。よって見出しの直後がラッパーになる。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `agent-browser open http://localhost:3000/login` → `snapshot` | ログイン画面が正常描画される | 見出し「ログイン」・フォーム・リンク 2 本を確認。ベースライン: シート内側幅 336px、ラッパー `mt-section flex flex-col` の `margin-top: 36px`、h1 → ラッパー 36px | PASS |
| 2 | dev サーバー停止（PID kill） | サーバーが応答しなくなる | `curl` が `000`（server down）、プロセス消滅を確認 | PASS |
| 3 | 「アカウント登録」リンクをクリック（クライアント遷移） | `ErrorScreen` が描画される | `/signup` で `main` 配下に h1「エラーが発生しました」、button「再読み込み」、link「タイムラインへ」 | PASS |
| 4 | 見出し・再読み込みボタン・タイムラインへリンクの存在確認 | 3 要素とも表示 | すべて表示。description は無し（メッセージが `ERROR_TITLE` と同一のため仕様どおり省略） | PASS |
| 5 | 「再読み込み」ボタンの幅とシート内側幅を計測 | 一致（ブロック幅） | ボタン **336px** = 内側幅 **336px**（`clientWidth 416 - padding 40+40`）。左端も一致（ボタン left 472 = シート内容左端 472） | PASS |
| 6 | ラッパー `div.mt-section` の `margin-top` を計測 | 36px（`--space-section`） | **36px**（`--space-section: 2.25rem`） | PASS |
| 7 | 見出しからの間隔を EDGE-1 / 確認項目 3 と比較 | 同じ 36px | h1 bottom → ラッパー top が **36px**。EDGE-1（`/no-such-page`）・TC-3（`/password-reset`）の「見出し／説明文 → ラッパー」36px と一致 | PASS |
| 8 | シート配下の全要素の computed `margin-bottom` を走査 | `0px` 以外が 0 件 | 0 件（`nonZeroMarginBottom: []`） | PASS |

## 計測値

AuthSheet（`main > div`、padding 左右 40px、`clientWidth` 416px）:

| 項目 | 値 |
|------|-----|
| シート内側幅（`clientWidth` - `paddingLeft` - `paddingRight`） | **336px** |
| ラッパー `div.mt-section flex flex-col` の幅 | 336px |
| `ErrorRetry` の外側 `div.flex gap-lg flex-col` の幅 | 336px |
| 「再読み込み」ボタンの `getBoundingClientRect().width` | **336px** |
| ボタン左端 / シート内容左端 | 472 / 472（一致） |
| ラッパーの `margin-top` | **36px**（`--space-section: 2.25rem`） |
| 見出し（h1）→ ラッパーの実間隔 | **36px** |
| ボタン → 「タイムラインへ」の実間隔 | 24px（`gap: 24px` = `--space-lg`） |
| `margin-bottom` が 0px 以外の要素 | **0 件** |
| 横スクロール（`scrollWidth - clientWidth`） | 0 |

補足所見:

- ラッパーの computed `align-items` は `normal`（`stretch` の初期値と等価な挙動）。加えて `Button` 側が `fullWidth` で `w-full` を付けており、幅 336px は「ラッパーの stretch」と「`w-full`」の双方から担保されている。`AuthSheet` の flex column ラッパーはボタン幅を潰していない。
- 「タイムラインへ」の `p` は `text-sm text-center` で中央寄せ（`text-align: center`）。`fullWidth` 時のレイアウトどおり。
- ラッパーは `AuthSheet` 直下 3 子（ブランド / h1 / ラッパー）の最後尾。EDGE-1 の 4 子構成から description が抜けた形で、余白の担い手（`mt-section` / `mt-lg`）は同一。

## 失敗詳細（FAILの場合）

なし。

## 後始末

- dev サーバーは停止したまま（呼び出し元が再起動する想定）
- `agent-browser --session verify-error close` 実行済み
