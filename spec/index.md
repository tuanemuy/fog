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
| Phase 3: 技術設計 | 完了 | [domains/index.md](./domains/index.md)・spec/usecases/・[database/index.md](./database/index.md)・[async/index.md](./async/index.md)・[rotation/index.md](./rotation/index.md)・[recovery/index.md](./recovery/index.md)・spec/testcases/（55ユースケース + async 1ファイル + rotation 1ファイル + recovery 1ファイル・984ケース） |
| Phase 4: マニュアルテスト | 完了 | [manual-tests/index.md](./manual-tests/index.md)（7カテゴリ・208ケース） |
| デザイン（design-flow） | 完了 | [design/index.md](./design/index.md)・[design/tokens.md](./design/tokens.md)・spec/design/pages/（P-01〜P-14 の14画面 HTML） |

## 成果物

- [scenario/index.md](./scenario/index.md) — シナリオ設計（7カテゴリ・39シナリオ）
- [pages/index.md](./pages/index.md) — ページ設計（P-01〜P-14）
- [domains/index.md](./domains/index.md) — ドメイン設計（identity / memo / knowledge / search / trash / export）
- spec/usecases/ — ユースケース設計（6ドメイン・55ユースケース）
- [database/index.md](./database/index.md) — DB設計（ユーザー単位 SQLite-backed Durable Objects。User Data DO 18 テーブル / Identity Directory DO 7 テーブル）
- [async/index.md](./async/index.md) — 非同期実行の設計（3類型の判定規則と全数表の正本。同期実行 / Outbox event / local job）
- [rotation/index.md](./rotation/index.md) — 鍵ローテーションの設計（写像鍵の移送とメール暗号鍵の再暗号化。手順・2世代並存の規則・不変条件の正本）
- [recovery/index.md](./recovery/index.md) — cross-DO saga の終端と自動回収の設計（終端モード・kind 別の後始末の段・材料の寿命・operator 経路への受け渡し・不変条件の正本）
- spec/testcases/ — テストケース定義（55ユースケース + async 1ファイル + rotation 1ファイル + recovery 1ファイル・984ケース）
- [manual-tests/index.md](./manual-tests/index.md) — マニュアルテスト（208ケース）
- [design/index.md](./design/index.md) — デザイン方針（ソフトミニマリズム。採用ドラフト: [mock.html](./mock.html)）
- [design/tokens.md](./design/tokens.md) — デザイントークン
- spec/design/pages/ — 全14画面の HTML デザイン（単体でブラウザ表示可能）

## ADR

| # | タイトル |
|---|---|
| [001](./adr/001-restore-document-without-topic.md) | 所属トピックがハードデリート済みのドキュメントの復元 |
| [002](./adr/002-export-scope.md) | データエクスポートの範囲 |
| [003](./adr/003-source-link-after-hard-delete.md) | 出典リンク先のハードデリート後の表示 |
| [004](./adr/004-domain-boundaries.md) | ドメイン境界の切り方 |
| [006](./adr/006-memo-fulltext-update.md) | メモは全文置換（パッチ対象外） |

ランタイム構成に関する決定は台帳を持たず、結果を現在形で各成果物へ書く。DO 構成と非同期実行の判定規則は [async/index.md](./async/index.md)、物理形は [database/index.md](./database/index.md)、鍵ローテーションの手順は [rotation/index.md](./rotation/index.md)、cross-DO saga の終端と回収は [recovery/index.md](./recovery/index.md) が正本である。`spec/` は Issue 番号を持たない — 追跡の座標は Issue トラッカーと `docs/` が持ち、`spec/` はあるべき姿だけを現在形で述べる。委任先は「運用設計が定める」のように脱番号化した形で書く。
