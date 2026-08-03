# PR Review #002 — D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

**PR:** #49
**Date:** 2026-08-03
**Round:** 2回目

## Summary

- Blockers: 2
- Warnings: 24
- Notes: 47
- Verdict: **BLOCKED**

## 1回目指摘の修正状況

| 観点 | 解消 | 不十分・未対応 |
|---|---|---|
| Domain / Use Case | 10 | 0 |
| Adapter / Infrastructure | 12 | 0 |
| Security | 11 | 0 |
| Test | 19 | 1（W-007 — 検証は入ったがテストが不安定。本ラウンド B-001 として再掲） |
| Presentation / Config | 8 | 0 |
| **計** | **60** | **1** |

1回目の59件（B12 + W47）はすべて対応済み。ただし修正が新しい面を露出させたものが5件ある（下記）。

## 修正が新たに露出させた問題

| 1回目の修正 | 露出した問題 |
|---|---|
| ADR-043（`operation_key` に時間窓） | 窓が60秒→15分になり、リセット恒久ロックアウト攻撃のコストが1/15に低下（SEC-W-001 / ADP-W-001） |
| ADR-042（リセットトークン再設計） | `parseResetToken` が `generation` / `bucket` を範囲検査せず返す（SEC-W-003） |
| ADR-047（`activate`/`promote` の0行検出） | 同じ形の `beginChange` が分類表から漏れた（ADP-W-002） |
| ADR-061（`redactForClient` の3分類） | 潰した4 kind が `toClientError` のログ条件に入らず、ワイヤからもログからも消える（PRES-W-001） |
| ADR-063（`APP_URL` を 3000 に固定） | `strictPort` が無く実測3013に流れ、`og:url` が到達しないポートを指す（PRES-W-002） |

## レイヤー別ファイル

- Domain / Use Case: review-002-domain-usecase.md（B: 0 / W: 5）
- Adapter / Infrastructure: review-002-adapter-infra.md（B: 1 / W: 3）
- Security: review-002-security.md（B: 0 / W: 4）
- Test: review-002-test.md（B: 1 / W: 6）
- Presentation / Config・Build・Docs: review-002-presentation-config.md（B: 0 / W: 6）

## カバレッジ

- 確認申告ゼロのファイル: なし（248件すべてが1体以上のレビュアーに言及されていることを機械検証済み）
- 各レビュアーの申告: DOM 54+194 / ADP 176+72 / SEC 57+191 / TEST 65+183 / PRES 40+208 — いずれも合計248

## 独立収束した指摘

| 問題 | 到達したレビュアー |
|---|---|
| `sweep-reset-tokens` を投入するコードが存在せずハンドラが到達不能 | ADP-B-001 / SEC-W-002 |
| リセット恒久ロックアウト（`recordResetRequested` の無条件記録 + sliding 判定） | SEC-W-001 / ADP-W-001 |
| `docs/test.md` の `--sequence.shuffle` 主張に該当する仕組みが無い | PRES-W-006 / TEST-W-004 |

## 指摘一覧

### Blockers

- [ADP-B-001] `sweep-reset-tokens` を投入するコードが1行も無くハンドラが到達不能。`password_reset_tokens` の消費済み・期限切れ行が永久に削除されない（Directory DO は多ユーザー相乗りで10GB上限も共有） — `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- [TEST-B-001] 統合スイートが不安定。`alarmEntry.integration.test.ts` がフルスイート22回中2回赤。RPC が張った `setAlarm` をプラットフォームが配信し `deleteAlarm` スパイの窓に入る。同じ競合が `resetToken` / `identity` にも潜在（遅延注入で決定的に赤を確認）。AC-29 が確率的にしか成立していない — `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts`

### Warnings（24件）

- Domain: DOM-W-001（エラーコード名の spec 不一致）/ W-002（`.adr/008` への書き戻し欠落）/ W-003（`credentialMappingRules` の spec アンカー皆無）/ W-004（spec の `getCurrentUser` DTO 注記）/ W-005（`dedupeByCredentialId` のコメント不一致）
- Adapter: ADP-W-001（リセット恒久ロックアウト）/ W-002（`beginChange` が一致行数を読まない）/ W-003（#44 への引き継ぎ記録が無い）
- Security: SEC-W-001（同上ロックアウト）/ W-002（同上 sweep）/ W-003（`parseResetToken` の範囲検査）/ W-004（`providerIdempotencyKey` が完全長 HMAC と同値で外部へ出る）
- Test: TEST-W-001〜006（クリーンアップ JSDoc の断定 / AC-12(iii) 未検証 / バケット衝突で落ちうるテスト / docs/test.md の主張2件 / JSDoc の過大主張）
- Presentation: PRES-W-001〜006（redact とログの穴 / `strictPort` / エラー面3つの重複 / CLAUDE.md の streaming 規約欠落 / `.tpl` コメントの陳腐化 / docs/test.md）

各レイヤー別ファイルを参照。
