# fog 設計インデックス

## インプット

- [idea.md](./idea.md) — 初期アイデアと Phase 0 決定事項
- [requirements.md](./requirements.md) — 要件定義

## 進捗

| フェーズ | 状態 | 成果物 |
|---|---|---|
| Phase 0: 準備 | 完了 | idea.md |
| Phase 1: シナリオ設計 | 完了 | [scenario/index.md](./scenario/index.md)（account / timeline / document / search / trash / ai / settings） |
| Phase 2: ページ設計 | 完了 | [pages/index.md](./pages/index.md)（P-01〜P-14 の14画面） |
| Phase 3: 技術設計 | 完了 | [domains/index.md](./domains/index.md)・spec/usecases/・[database/index.md](./database/index.md)・[async/index.md](./async/index.md)・spec/testcases/（54ユースケース + async 1ファイル・874ケース）・クロスフェーズ検証（spec/review/cross-phase/） |
| Phase 4: マニュアルテスト | 完了 | [manual-tests/index.md](./manual-tests/index.md)（7カテゴリ・207ケース） |
| デザイン（design-flow） | 完了 | [design/index.md](./design/index.md)・[design/tokens.md](./design/tokens.md)・spec/design/pages/（P-01〜P-14 の14画面 HTML）・spec/design/review/（5ラウンド） |

## 成果物

- [scenario/index.md](./scenario/index.md) — シナリオ設計（7カテゴリ・39シナリオ）
- [pages/index.md](./pages/index.md) — ページ設計（P-01〜P-14）
- [domains/index.md](./domains/index.md) — ドメイン設計（identity / memo / knowledge / search / trash / export）
- spec/usecases/ — ユースケース設計（6ドメイン・54ユースケース）
- [database/index.md](./database/index.md) — DB設計（ユーザー単位 SQLite-backed Durable Objects。User Data DO 17 テーブル / Identity Directory DO 7 テーブル）
- [async/index.md](./async/index.md) — 非同期実行の設計（3類型の判定規則と全数表の正本。同期実行 / Outbox event / local job）
- spec/testcases/ — テストケース定義（54ユースケース + async 1ファイル・874ケース）
- [manual-tests/index.md](./manual-tests/index.md) — マニュアルテスト（207ケース）
- spec/review/cross-phase/ — クロスフェーズ検証
- [design/index.md](./design/index.md) — デザイン方針（ソフトミニマリズム。採用ドラフト: [mock.html](./mock.html)）
- [design/tokens.md](./design/tokens.md) — デザイントークン
- spec/design/pages/ — 全14画面の HTML デザイン（単体でブラウザ表示可能）
- spec/design/review/ — デザインレビュー記録（視覚確認 / critique / polish / audit / issues対応の5ラウンド）

## ADR

| # | タイトル |
|---|---|
| [001](./adr/001-restore-document-without-topic.md) | 所属トピックがハードデリート済みのドキュメントの復元 |
| [002](./adr/002-export-scope.md) | データエクスポートの範囲 |
| [003](./adr/003-source-link-after-hard-delete.md) | 出典リンク先のハードデリート後の表示 |
| [004](./adr/004-domain-boundaries.md) | ドメイン境界の切り方 |
| [005](./adr/005-search-index-via-outbox.md) | 検索インデックスの更新方式（superseded。根拠側は `.adr/003`、方式側は `.adr/004`。本文は当時の決定の記録として保持する。**`.adr/013` が訂正したのは Outbox 機構そのものの廃止であって、検索インデックスの更新方式ではない** — 本 ADR を検索 indexer consumer の復活根拠に使わない） |
| [006](./adr/006-memo-fulltext-update.md) | メモは全文置換（パッチ対象外） |

ランタイム構成に関する決定はリポジトリ直下の `.adr/` にある。

| # | タイトル |
|---|---|
| [.adr/002](../.adr/002-cloudflare-workers-and-user-data-durable-objects.md) | Cloudflare Workers とユーザー単位 Durable Objects を本番構成とする |
| [.adr/003](../.adr/003-sqlite-fts5-only-search.md) | 検索は SQLite FTS5 の全文検索のみとする（`spec/adr/005` の根拠側を supersede） |
| [.adr/004](../.adr/004-do-local-commit-and-alarm-jobs.md) | ローカル同期コミットと Alarm ジョブへ移行する（`spec/adr/005` の更新方式を supersede）。**一部が `.adr/013` に supersede されている** — 失効するのは決定の第3項（ドメインイベント transport の廃止）と、第2項のうち「外部 I/O を伴う処理は必ずこちらに載る」という十分条件。**永続ジョブと Alarm という機構そのものと第1項は有効である** |
| [.adr/013](../.adr/013-do-local-outbox-and-alarm-relay.md) | DO ローカル Outbox と Alarm relay へ移行し、ドメインイベント配送を維持する（全数表の正本は [async/index.md](./async/index.md)） |
