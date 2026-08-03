# PR Review #005（最終） — D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

**PR:** #49
**Date:** 2026-08-03
**Round:** 5回目（最終）

## Summary

- Blockers: 0
- Warnings: 0
- Notes: 6（すべて記録・環境・引き継ぎに関するもの。コード変更を要さない）
- Verdict: **APPROVED**

## レイヤー別ファイル

- 最終確認（General Review）: review-005-final.md（B: 0 / W: 0）

4回目の差分が `CLAUDE.md` 1行と `triage.md` の記録追記だけだったため、レビューガイドの「変更規模に応じて1〜5レイヤー」に従い1観点に絞った。

## 過去4周の指摘の決着

**全件決着（未対応ゼロ）。**

`triage.md` 88行の内訳: `fix` 86 / `wont-fix`（担当範囲外）1 / `fix`（記録のみ）1。
担当ファイル範囲の制約で保留された3件は、いずれも後続の「spec 同期」行が実ファイルへ着地させていることを確認済み。

## ラウンドごとの推移

| ラウンド | Blockers | Warnings | 観点数 | Verdict |
|---|---|---|---|---|
| 1 | 12 | 47 | 5 | BLOCKED |
| 2 | 2 | 24 | 5 | BLOCKED |
| 3 | 0 | 3 | 5 | BLOCKED（5観点すべて「マージ可」判定だが Warning 3件とも実バグのため修正） |
| 4 | 0 | 1 | 2 | BLOCKED（PR 本文の陳腐化のみ、コード変更不要） |
| 5 | 0 | 0 | 1 | **APPROVED** |

**修正した指摘の総数: 86件**（Blocker 14 / Warning 72、重複収束分をまとめた後の実数）

## AC 30項目

**OK 30 / NG 0。**

機械検証コマンドが書かれた11項目（AC-4 / 5 / 8 / 14 / 17 / 18 / 20 / 23 / 25 / 26 / 29）はすべて実行し規定件数を確認。

- AC-4: 2件（両方 `serverCloudflare.ts`）
- AC-5 / 8 / 14 / 20 / 25: いずれも0件
- AC-18: `db:*` 0本 / `deploy:*` 両側12本
- AC-26: `.wrangler/deploy/config.json` が request 側を指したまま `-c wrangler.state.toml --dry-run` が state Worker を 114.16 KiB / DO バインディング2本でバンドルすることを再現（redirect に引きずられない）

## 全ゲートの実行結果

| コマンド | 回数・シード | 結果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 1 | OK |
| `pnpm typecheck` / `lint` / `format:check` | 各1 | すべて exit 0 |
| `pnpm test:unit` | 1 | 36 files / **525 passed** |
| `pnpm test:integration` | **3回連続** | いずれも 19 files / **187 passed** |
| `pnpm test:integration:shuffle` | **4シード**（11111 / 24680 / 99991 / 777777） | いずれも 187 passed |
| クリーンビルド → `pnpm test:smoke` | 1 | 2成果物生成、smoke **2 passed** |
| `git status` | — | clean |

## 特筆事項

- **統合スイートの不安定性**（2回目 B-001）は根本原因まで特定して解消した。プラットフォーム自身の Alarm 配信が第二の駆動者になっていた形で、遅延注入による決定的再現 → 修正 → 陰性対照（`disarm` を no-op に潰すと再発）まで確認済み。以降 4・5周目で通算25回以上・11シード以上を緑で通している
- **独立収束した指摘が6件あった**（複数レビュアーが同一問題に到達）。いずれも実バグで、うち2件は Blocker
- **変異試験**を各ラウンドで実施し、新規テストの検出力を実証している（レビュアー側でも独立に再実施し、修正エージェントの主張を検証した）
