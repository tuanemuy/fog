# PR Review #003 — D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

**PR:** #49
**Date:** 2026-08-03
**Round:** 3回目

## Summary

- Blockers: 0
- Warnings: 3
- Notes: 40
- Verdict: **BLOCKED**（Warning 3件を修正して次ラウンドへ。5観点すべてが「マージ可」判定だが、3件とも実バグで修正が小さい）

## 2回目指摘の修正状況

| 観点 | 解消 | 不十分・未対応 |
|---|---|---|
| Domain / Use Case | 5 | 0 |
| Adapter / Infrastructure | 4 | 0 |
| Security | 4 | 0 |
| Test | 7 | 0 |
| Presentation / Config | 6 | 0 |
| **計** | **26** | **0** |

2回目の26件（B2 + W24）はすべて解消。**新たな退行はゼロ。**

## 各観点のマージ可否判定

| 観点 | Blockers | Warnings | 判定 |
|---|---|---|---|
| Domain / Use Case | 0 | 0 | 可 |
| Adapter / Infrastructure | 0 | 2 | 可 |
| Security | 0 | 0 | 可 |
| Test | 0 | 1 | 可 |
| Presentation / Config | 0 | 0 | 可 |

## 指摘一覧

- [ADP-W-001] `armAfterRpc` が既存 Alarm を**後ろへずらせる**（`clamp` → `now+1000` を `persist` が無条件に `setAlarm`）。毎秒1回以上 RPC が届く Directory bucket では due なジョブが永久に走らない。修正は「前倒し専用」にする1行 — `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- [ADP-W-002] 「適格な依頼は必ず未使用の `operationKey` に着地する」不変条件が**写像行の生成をまたぐと破れる**。未登録アドレスへの依頼が残した `done` 行に、同一窓の登録直後の依頼が衝突して無言でメールが出ない（最大1窓）。修正は `reserve` の `INSERT` で `last_reset_requested_at` を NULL でなく `created_at` にする1バインド — `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- [TEST-W-001] AC-12 (iii) が Identity Directory DO クラスについて未担保。`identityDirectory.ts` の `entry()` から `runRpcEntry` を外し arming を落としても統合スイート184件が全緑（変異試験で実測）。**2回目の修正が持ち込んだ穴ではなく既存の欠落**。User Data 側は `cleanup.integration.test.ts` が覆っているので Directory 側にも同型を1本 — `apps/web/app/durable-objects/identityDirectory.ts`

## カバレッジ

- 確認申告ゼロのファイル: なし（259件すべてが1体以上のレビュアーに言及されていることを機械検証済み）
- 各レビュアーの申告: DOM 60+199 / ADP 178+81 / SEC 44+215 / TEST 27+232 / PRES 47+212 — いずれも合計259

## 安定性の検証（Test 観点が実施）

2回目 B-001（統合スイートの不安定性）の修正が本物であることを独立に確認:

- フルスイート **25回すべて緑**（連続6 + シャッフル7シード + CPU飽和下10回 + 遅延注入1 + 最終1）
- 2回目で赤だったシード `31337` を含む
- **陰性対照**: `disarm` を no-op に潰すと5本が決定的に赤
- 2回目の報告と同一メッセージ（`expected 2 to be 1`）を決定的に再現し、`disarm` を戻すと緑
- DO 名衝突は同一バケットの固定名に強制しても 184 passed（`reset()` が毎テスト全消しするため）→ **対処不要**

## AC の機械検証

Presentation 観点が AC-4 / 5 / 14 / 17 / 18 / 19 / 20 / 21 / 22 / 25 / 26 / 28 / 29 を実行し、**通らなかったものはゼロ**。
