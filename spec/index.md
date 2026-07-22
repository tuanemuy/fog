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
| Phase 3: 技術設計 | 完了 | [domains/index.md](./domains/index.md)・spec/usecases/・[database/index.md](./database/index.md)・spec/testcases/（52ユースケース・約750ケース）・クロスフェーズ検証（spec/review/cross-phase/） |
| Phase 4: マニュアルテスト | 完了 | [manual-tests/index.md](./manual-tests/index.md)（7カテゴリ・192ケース） |

## 成果物

- [scenario/index.md](./scenario/index.md) — シナリオ設計（7カテゴリ・43シナリオ）
- [pages/index.md](./pages/index.md) — ページ設計（P-01〜P-14）
- [domains/index.md](./domains/index.md) — ドメイン設計（identity / memo / knowledge / search / trash / export）
- spec/usecases/ — ユースケース設計（6ドメイン・52ユースケース）
- [database/index.md](./database/index.md) — DB設計（SQLite系・9テーブル＋共通基盤）
- spec/testcases/ — テストケース定義（52ユースケース・約750ケース）
- [manual-tests/index.md](./manual-tests/index.md) — マニュアルテスト（192ケース）
- spec/review/cross-phase/ — クロスフェーズ検証

## ADR

| # | タイトル |
|---|---|
| [001](./adr/001-restore-document-without-topic.md) | 所属トピックがハードデリート済みのドキュメントの復元 |
| [002](./adr/002-export-scope.md) | データエクスポートの範囲 |
| [003](./adr/003-source-link-after-hard-delete.md) | 出典リンク先のハードデリート後の表示 |
| [004](./adr/004-domain-boundaries.md) | ドメイン境界の切り方 |
| [005](./adr/005-search-index-via-outbox.md) | 検索インデックスの更新方式 |
| [006](./adr/006-memo-fulltext-update.md) | メモは全文置換（パッチ対象外） |
