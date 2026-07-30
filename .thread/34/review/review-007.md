# PR Review #007 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 7回目

## Summary

- Blockers: 2
- Warnings: 6
- Notes: 34
- Verdict: **BLOCKED**

Blocker 推移: 17 → 14 → 13 → 6 → 2 → 5 → 2。

**4層中3層が Blocker ゼロに到達**（セキュリティ / 非同期・UoW / 引き継ぎ性）。引き継ぎ性は **Warning もゼロ**で、指摘はすべて Notes。

残る Blocker 2件は同根で、**「routing 鍵のローテーションと暗号化鍵のローテーションは独立に走らせてよい」という1文が未検証**であること。両者が `rotation_checkpoints` を共有しているのに区別列が無く、片方の完了記録が他方の旧鍵破棄条件を誤成立させる。

前ラウンドで新設した第1.4節（「全数」表の不変条件 I-1〜I-8 と機械検査）は、4層すべてが実際に検査1〜7 を実行して**全項目パス**を確認した。ただし今回の Blocker は「I-4 の逆向き（第4.1.1節の列が本文のどこで書かれるか）」と「E-2 の書き込み箇所欄の一致」を機械化していないためすり抜けている。

事実の照合は今ラウンドも全層で実施し、**実装事実・Cloudflare 公式・SQLite 公式ともに誤りゼロ**。

## レイヤー別ファイル

- DO 境界・ルーティング: review-007-do-boundary.md（B: 2 / W: 1）
- 非同期処理・UoW・migration: review-007-async-uow.md（B: 0 / W: 3）
- セキュリティ: review-007-security.md（B: 0 / W: 2）
- 引き継ぎ性・成果物制約・ドキュメント品質: review-007-handoff.md（B: 0 / W: 0）

## 指摘一覧

### Blockers

- [B-001] `rotation_checkpoints` を routing / 暗号化の2ローテーションが共有し区別列が無い。片方の完了記録が他方の旧鍵破棄条件を誤成立させる — `.thread/34/design.md:380,398,946,1252,1257,1265`
- [B-002] 移送が古い `encryptionGeneration` の行を `rotate-encryption` 完走済み bucket へ運び、再武装経路が無いまま暗号化旧鍵が退役しうる — `.thread/34/design.md:1236,1256,1257,1463`

### Warnings

- [W-001] 第1.3節「全10件 + レビュー指摘2件」「保留はゼロ」が表14行および #19 の実体（ADR-009 に採否行なし）と不一致。検査7 の grep がこの形の数え上げを拾わない — `.thread/34/design.md:38,41-55`
- [W-002] `reindex` の内部カーソルに永続先が定義されていない（E-1 の `jobs` 12列にも `migration_progress` にも第8.2節の書き込み口にも無い） — `.thread/34/design.md:1492,1498,1856,373,395,1663`
- [W-003] claim の CAS 述語に `status` の絞りが無く `done` / `poison` 行を再 claim しうる。同じ根で `deleteAlarm()` の発火条件が節内で2通りに書かれている — `.thread/34/design.md:1476,1517,1470,1478`
- [W-004] 第4.7節の `retryable` 欄が実装と食い違う（`SystemError(DatabaseError)` を true と書くが `RETRYABLE_SYSTEM_CODES` に含まれず false。行1 の「ConflictError はリトライ可能系」も同表 行4 と不一致） — `.thread/34/design.md:519,517` / `packages/core/src/application/errors.ts:206-210`
- [W-005] `rotate-remap` の「previous 世代の鍵の所持証明」が鍵漏えい起因のローテーションでは成立せず、漏えい鍵の失効手段そのものを漏えい鍵の保持者が無効化できる — `.thread/34/design.md:596,627,699,1297`
- [W-006] リセット完了時の AI クライアント接続の自動失効（`createdAtCredentialVersion` 1世代分）が、最頻の乗っ取り系列（接続作成 → パスワード変更）でちょうど空振りする — `.thread/34/design.md:780,369,1104`

### 第1.4節の検査の穴（Blocker / Warning の再発防止として併せて直す）

- I-2 の検査が分類列だけを見るため、**同一 `kind` が複数の分類表に現れること**を検出できない（async-uow W-001 の指摘由来。今ラウンドで該当は解消済みだが検査には穴が残る）
- I-4 の**逆向き**（第4.1.1節の列が本文のどこで書かれるか）と、E-2 の**書き込み箇所欄の一致**が機械化されていない（B-001 / B-002 がここをすり抜けた）
- 検査7 が「全10件」のような**散文中の数え上げ**を拾わない（W-001 がここをすり抜けた）

### Notes 由来（対応不要と判断するもの）

- async-uow N-011 — 第7.7節 項2 の類型名と第7.4節 (iii) の対象集合が別の軸である旨の補足。レビュアー自身が「必須ではない」と明記
