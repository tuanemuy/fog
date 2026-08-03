# PR Review #007（最終） — D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

**PR:** #49
**Date:** 2026-08-03
**Round:** 7回目（最終）

## Summary

- Blockers: 0
- Warnings: 2（どちらもドキュメントの記述精度。コード・テスト・型・設定に影響なし）
- Verdict: **APPROVED**

## 経緯

5周目で一度 APPROVED に到達したあと、Phase 4 のブラウザ検証で**変更起因の FAIL を1件検出**したため、レビューループへ戻った。

| ラウンド | 観点数 | Blockers | Warnings | Verdict |
|---|---|---|---|---|
| 1 | 5 | 12 | 47 | BLOCKED |
| 2 | 5 | 2 | 24 | BLOCKED |
| 3 | 5 | 0 | 3 | BLOCKED |
| 4 | 2 | 0 | 1 | BLOCKED |
| 5 | 1 | 0 | 0 | APPROVED |
| — | — | — | — | ブラウザ検証で TC-E03 が FAIL → 修正 |
| 6 | 1 | 0 | 2 | BLOCKED |
| 7 | 1 | 0 | 2 | **APPROVED** |

**指摘の総数: 93件**（Blocker 14 / Warning 79）。`defer` ゼロ、`wont-fix` 1件（担当ファイル範囲外の記録漏れで、後続の spec 同期が実ファイルへ着地させた）。

## 7周目の指摘と対応

- **[W-001]** `spec/database/index.md` の `kind` 全数表の `reindex` 行が「トークナイザ・正規化規則の変更時」と書いたままで、同ファイルの「検索」節（1周目の指摘で「射程はトークナイザの変更に限る」と追記済み）と自己矛盾していた → **表側を揃えた**。正規化規則の変更が #2〜#6 の担当であることと参照先も明記
- **[W-002]** PR 本文の ADR 本数が2箇所（33行目「41本」/ 141行目「82本」）で食い違い、どちらも実測（84本）と不一致 → **両方を実測値へ更新**

いずれもレビュアーが逐語で指定した訂正であり、コード変更を伴わない。

## 7周目レビュアーが行った検証

- **変異試験 MUT-1**（`isThenable(result) ? Promise.resolve(result).catch(…)` → `result instanceof Promise ? result.catch(…)`）: integration 2本 + unit 2本が赤。**6周目で追加した統合テストが単独で検出する**ことを確認
- **実測プローブ2本**で ADR-131 の訂正後の記述を裏取り: `Symbol` 引数 → `[object JsRpcPromise]` が `DataCloneError` で**非同期 reject**／関数引数 → **stub 化されて DO へ到達**。両主張とも実態どおり
- 過去6周の指摘91件を triage と突き合わせ、台帳漏れなし
- AC 30項目すべて OK
- ブラウザ検証17ケースすべて PASS（FAIL 0 / SKIP 0）

## 全ゲートの実行結果

| コマンド | 回数・シード | 結果 |
|---|---|---|
| `pnpm install --frozen-lockfile` / `typecheck` / `lint` / `format:check` | 各1 | すべて exit 0 |
| `pnpm test:unit` | 1 | 37 files / **532 passed** |
| `pnpm test:integration` | **3回** | いずれも 20 files / **189 passed** |
| `pnpm test:integration:shuffle` | **3シード**（20260803 / 4711 / 90210） | いずれも 189 passed |
| クリーンビルド → `pnpm test:smoke` | 1 | **2 passed** |

## ブラウザ検証で見つけた不具合（5周目 APPROVED 後）

**TC-E03: `guardStub` の失敗翻訳が非同期経路で発火しない。**

workerd の JS RPC は本物の `Promise` を返さない（workerd 自身の型定義に「custom thenables here, but they quack like Promises」とある）ため、`result instanceof Promise` が false になり、DO 到達不能などのプラットフォーム失敗がすべて未翻訳のまま抜けていた。CLAUDE.md が定める「stub 呼び出し自体の失敗は呼び出し側アダプターが翻訳する」が実際には効いていない状態。

`then` の有無による構造判定へ置き換えて解消。**5周にわたる静的レビューが到達できず、実機のブラウザ検証だけが見つけた**という点で、Phase 4 を省略していたら見逃していた不具合である。

なお `typeof value === "object"` での thenable 判定では不足で、本物の `Rpc.Result` は `typeof` が `"function"`（pipelining の provider を兼ねる）。この事実も実測で確定させた。
