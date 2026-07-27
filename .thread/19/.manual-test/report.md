# Browser Verify Report

**実行日時**: 2026-07-28 05:59〜06:32 JST  
**テストソース**: `.thread/19/testing.md`  
**サーバー**: `http://localhost:8787`  
**修正ラウンド**: 2回

## サマリー

| 項目 | 値 |
| --- | --- |
| テストケース総数 | 2 |
| PASS | 2 |
| FAIL | 0 |
| PASS率 | 100% |
| 起票Issue数 | 0 |

## シードデータ

ローカル workerd の UI から予約ドメインの password アカウントを1件作成した。
共有・remote データ、Durable Object storage、Cloudflare secret は変更していない。
実値を記録しない3つのローカル専用 secret を request Worker にだけ設定した。

## テスト結果一覧

| TC | テスト名 | 種別 | 最終結果 | 初回結果 | 修正ラウンド | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-001 | 登録・設定・ログアウト・再ログイン・セッション維持 | 正常系 | PASS | FAIL | Round 1〜2 | `/settings` full reload の未解決 RSC loader data と development hydration の `__name` エラーを、最小 DTO loader に変更して解消 |
| TC-002 | 未登録／誤パスワードの公開エラー同一性 | 異常系 | PASS | PASS | - | 両方とも status 422、`validation`、`INVALID_CREDENTIALS`、同一 UI message |

TC-001 は登録、設定表示、cookie属性、ログアウト、再ログインまでは初回から
成功した。full reload の白画面を2回再現し、Round 2 で
`ReferenceError: __name is not defined` を特定した。修正後の Round 3 では
設定内容とログアウト操作が即時復元し、console/page error は0件だった。

TC-002 の SSO-only と不正形式メールは通常 UI の安全境界を迂回せず、
4経路の公開 error envelope と work profile を比較する既存自動契約で補完した。

## 起票した Issue

なし。検出した TC-001 の不具合は本 Issue 内で修正し、再検証で解消した。

## 環境情報

- OS: Darwin
- Node.js: v24.14.1
- agent-browser: 0.33.0
- サーバーコマンド: `pnpm dev:cf`
- ポート: 8787
