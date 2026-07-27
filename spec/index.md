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
| Phase 3: 技術設計 | Issue #19 で同期済み | [domains/index.md](./domains/index.md)・spec/usecases/・[database/index.md](./database/index.md)・spec/testcases/。レビュー履歴は当時の判断を保持 |
| Phase 4: マニュアルテスト | Issue #19 で同期済み | [manual-tests/index.md](./manual-tests/index.md)（7カテゴリ。identityは#19公開範囲へ縮小） |
| デザイン（design-flow） | 完了 | [design/index.md](./design/index.md)・[design/tokens.md](./design/tokens.md)・spec/design/pages/（P-01〜P-14 の14画面 HTML）・spec/design/review/（5ラウンド） |

## 成果物

- [scenario/index.md](./scenario/index.md) — シナリオ設計（7カテゴリ）
- [pages/index.md](./pages/index.md) — ページ設計（P-01〜P-14）
- [domains/index.md](./domains/index.md) — ドメイン設計（identity / memo / knowledge / search / trash / export）
- spec/usecases/ — ユースケース設計（6ドメイン + identity saga/Alarm contract）
- [database/index.md](./database/index.md) — DB設計（3 SQLite-backed Durable Object class、FTS5、Alarm job）
- spec/testcases/ — テストケース定義（業務ケース + workerd/DO/identity contract）
- [manual-tests/index.md](./manual-tests/index.md) — マニュアルテスト（7カテゴリ）
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
| [005](./adr/005-search-index-via-outbox.md) | 検索インデックスの旧更新方式（Issue #19 で superseded） |
| [006](./adr/006-memo-fulltext-update.md) | メモは全文置換（パッチ対象外） |
