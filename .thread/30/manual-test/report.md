# ブラウザ検証レポート — Issue #30 / PR #32

**実行日時**: 2026-07-26
**テストソース**: `.thread/30/testing.md`
**サーバー**: http://localhost:3000（Node + libSQL / `pnpm dev`）
**検証対象**: 縦余白を上向きに統一し `mb-*` を排除する変更

## 結果

**10 件すべて PASS**（正常系 6 / 異常系 2 / 回帰 2）。FAIL・起票した Issue ともになし。

詳細は `results/summary.md` と `results/*.md` を参照。

## 検証のアプローチ

本 Issue は「見た目を変えずに余白の担い手だけを移す」変更なので、目視ではなく `getBoundingClientRect` と `getComputedStyle` による数値計測で検証した。各画面で次の 3 点を確認している。

1. 隣接要素間の実際の間隔（px）が設計 HTML の CSS 値と一致すること
2. 余白が `margin-top` 側に乗っていること（`margin-bottom` が 0px 以外の要素がないこと）
3. description の有無で見出しの `margin-top` が変わらないこと（本 Issue の眼目 = AC-2）

## 主要な確認結果

- **AuthSheet 系 4 画面**（`/login`・`/signup`・`/password-reset`・404）で、ブランド→見出し 36px、見出し→説明 24px、説明→本文 36px を実測。`/password-reset` と 404 は座標レベルで完全一致
- **エラー画面**の「再読み込み」ボタン幅 336px = シート内側幅 336px。ADR-001 のラッパーが `ErrorRetry fullWidth` の幅を潰していないことを確認（plan.md がリスクに挙げていた点）
- **サイドバーのブランドリンク**の高さ 26px / `padding-bottom` 0px。設計は `.brand` の `padding-bottom` で 40px を持つが、実装は `<nav>` の `mt-2xl` に移したためクリック領域が下に広がっていない（ADR-002 の眼目）
- **スケルトン → 実 DOM のスワップ**は 10ms 間隔のサンプラーで両フレームを捕捉し、`section` の起点差 0・ラベル→先頭行が両者とも 8px であることを動的に確認（静的確認へのフォールバックは不要だった）
- **回帰**: ナビの開閉・フォーカス移動・Escape・オーバーレイクリック、ログインの成功/失敗・エラー表示・フォーカス移動・メールアドレスの復元、いずれも従来どおり

## 記録すべき差分（FAIL ではない）

- **設定画面の見出し下は実装 8px / 設計 12px**。Issue #30 が明示的に `mt-sm` を指示しているための意図的な据え置きで、レビュー台帳でも `defer` 判定済み。現行トークンに 12px 相当がなく（`sm`=8px / `md`=14px）、追随するならトークン追加が要る → Phase 5 で別 Issue 化
- **スケルトンのログアウトブロックで最大 3px の位置差**。原因は余白ではなくコンテンツ高（`h-skeleton-line` 16px vs 実テキスト行高 17.83px）が行ごとに約 1px 累積するもの。本 Issue の対象外

## テスト手順書の修正

検証中に `.thread/30/testing.md` の記述 2 箇所が実態と合わないことがわかり、実測に基づいて修正した。

1. **検証アカウント** — ローカル DB の `test@example.com` は存在するがパスワードが `password123` ではなくログインできない。`/signup` で検証用アカウントを作る手順に差し替えた
2. **エラー画面の出し方** — `.env` の `DATABASE_URL` を壊す方法は dev サーバーでは使えない（SSR が Vite のエラーオーバーレイで落ち、アプリの `ErrorScreen` まで到達しない）。「サーバー停止 → クライアントサイド遷移でルートの `beforeLoad` を失敗させる」手順に差し替えた

## 環境への影響

- ローカル開発 DB（`apps/web/data/app.db`）に検証用ユーザー `appshell-check@example.com` を作成した。本番データではないためそのまま残す
- `apps/web/.env` は検証中に一時的に書き換えたが、元に戻して再起動済み
- dev サーバー・agent-browser セッションはいずれも停止・close 済み
