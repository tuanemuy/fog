# テスト実行サマリー

**実行日時**: 2026-07-29
**テストソース**: `.thread/36/testing.md`
**サーバー**: http://localhost:3000（`pnpm dev` = `vite dev --config vite.config.cloudflare.ts`）
**ブランチ / PR**: `issue/36/remove-node-aws-gcp-runtimes` / #39

| TC | テスト名 | 種別 | 結果 | 失敗ステップ |
|----|---------|------|------|-------------|
| TC-001 | 撤去後の依存構成で `pnpm install --frozen-lockfile` が通る | コマンド | PASS | - |
| TC-002 | 未認証のトップページがログイン画面に誘導される | 正常系 | PASS | - |
| TC-003 | アカウント登録からログインまでが従来どおり動く | 正常系 | PASS | - |
| TC-004 | グローバルナビの5画面がすべて表示・遷移できる | 正常系 | PASS | - |
| TC-005 | 設定画面がスケルトンから実データへストリーミングされ、ログアウトできる | 正常系 | PASS | - |
| TC-006 | `pnpm db:migrate` の既定が D1 を指している | コマンド | PASS | - |
| TC-007 | `pnpm build` が Cloudflare 構成で完了する | コマンド | PASS | - |
| TC-008 | `pnpm start` のスクリプト定義が Cloudflare 構成を指している（実行しない） | コマンド | PASS | - |
| TC-009 | 静的検査・テストがすべて green で件数が想定どおり減る | コマンド | PASS | - |
| TC-E01 | 未認証で保護画面を直接開くと `?redirect=` 付きで往復する | 異常系 | PASS | - |
| TC-E02 | 存在しないパスで 404 画面が出る | 異常系 | PASS | - |
| TC-E03 | 誤ったパスワードでログインするとフォーム内にエラーが出る | 異常系 | PASS | - |

**合計**: 12 件（PASS: 12 / FAIL: 0）

## 実行できなかった項目

- **TC-005 手順1「Slow 4G に絞る」** — agent-browser にネットワークスロットリング機能がないため実行不可（`network` サブコマンドは route / requests / har のみ）。絞りなしで実行したが、MutationObserver でスケルトンの出現（+93.9ms）と消滅（+390.9ms、約297ms 表示）を計測でき、CLS = 0 も PerformanceObserver で実測できたため判定に影響なし。
- **TC-001 手順2「postinstall の `wrangler types` が走り切ること」** — `node_modules` が既に lockfile と整合していたため pnpm が install 自体をスキップし `postinstall` が発火しなかった。testing.md が名指しするコマンドを直接実行して成功と冪等性（生成後の `git status` が空）を確認したが、**クリーンな `node_modules` からの postinstall 発火は未検証**。
