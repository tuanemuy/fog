# PR Review #006 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 6回目

## Summary

- Blockers: 5
- Warnings: 11
- Notes: 26
- Verdict: **BLOCKED**

Blocker 推移: 17 → 14 → 13 → 6 → 2 → 5。

**今ラウンドの Blocker は前ラウンドの修正の副作用として開いたもので、3層が同じ構造を指している。** design.md には「全数」を名乗る表が複数ある:

| 表 | 場所 | 何の全数か |
|---|---|---|
| テーブル・列の正本 | 第4.1.1節 | 全テーブルと全列 |
| ストア分類 | 第4.1.1節 | 非集約ストア7分類 |
| `kind` 全数表 | 第7.4節 | 永続ジョブ12種 |
| 駆動源クエリ表 | 第7.4節 (1) | 周期・反復ジョブの再武装 |
| 非同期実行契約の正文 | 第7.7節 | ジョブに載るものの範囲 |
| UoW の書き込み口の全数 | 第8.2節 | 非集約ストアへの書き込み経路 |
| RPC エントリ表 | 第5.1節 | クラス (2)(3) の全エントリ |

**これらが互いに同期しておらず、片方を直すともう片方が取り残される。** 今ラウンドの Blocker 5件のうち4件がこの形（`jobs` の完了時刻列の不在 / 駆動源クエリ表の2行欠落 / `sweep-orphan-mapping` の投入点の不在 / ローテーション経路がクラス (3) の4群分類から漏れる）。Warning にも同型が3件（UoW 書き込み口が7分類中3つしか覆わない / `.adr/004` の決定文が第7.7節の正文と食い違う / 秘密の個数が実数と合わない）。

`.thread/34/review/triage.md` の運用規則（同じ箇所が3ラウンド以上別角度から再指摘されたら個別修正で追いかけず設計の問題として扱う）に該当する。R3（第4.1.1節と第6〜9章の不一致）・R5（正文と `kind` 全数表の矛盾）・R6（4件）と再燃しているため、**「全数」表どうしの整合を機械検証できる形にする構造的修正**で対処する。

## レイヤー別ファイル

- DO 境界・ルーティング: review-006-do-boundary.md（B: 1 / W: 2）
- 非同期処理・UoW・migration: review-006-async-uow.md（B: 1 / W: 2）
- セキュリティ: review-006-security.md（B: 1 / W: 2）
- 引き継ぎ性・成果物制約・ドキュメント品質: review-006-handoff.md（B: 2 / W: 5）

## 指摘一覧

### Blockers

- [B-001] `jobs` の「完了時刻」列が、列の全数の正本を名乗る第4.1.1節にも第7.4節の列表にも存在しない — `.thread/34/design.md:249,1226-1238`（要求側 `:1294`）
- [B-002] 第7.4節 (1) の駆動源クエリ表に `sweep-orphan-mapping` と `rotate-encryption` の行が無く、両ジョブの再武装が未定義 — `.thread/34/design.md:1275-1279`（要求側 `:1312`）
- [B-003] `sweep-orphan-mapping` の投入点が本文に無く、代替の再武装規則も適用できない（unlink の孤児 mapping が恒久未回収 → SSO 主体の永久ロック） — `.thread/34/design.md:1001,1259,1275-1279,1312`
- [B-004] retention **延長**時に `nextRunAt` を後ろへ動かす手段が UoW 契約に無く、収束規則の適用範囲・第4.1節・第7.5節の3箇所が矛盾 — `.thread/34/design.md:1265-1266,1365,228,1436,1465-1466`
- [B-005] ローテーション経路への `DIRECTORY_ROUTING_SECRET` 一時注入が bucket 側で検証不能、かつクラス (3) の4群分類から漏れている — `.thread/34/design.md:460,466,473,476,543-545,1046-1056`

### Warnings

- [W-001] 第8.2節の「非集約ストアへの書き込み口の全数」が、第4.1.1節の7ストア分類のうち3つしか覆っていない — `.thread/34/design.md:1466,263`
- [W-002] `.adr/004` の決定文が「外部 I/O と期限処理**だけ**」で、設計の正文（第7.7節 項2）が明示的に禁じた限定になっている（12種中8種が射程外） — `.adr/004-do-local-commit-and-alarm-jobs.md:24`
- [W-003] `sweep-reservations` / `sweep-reset-tokens` の投入点がどの節にも書かれていない（他10種は投入点あり） — `.thread/34/design.md:1275-1281,843-844,702,1269`
- [W-004] `rotate-remap` の競合分岐が `poison` / `terminalReason` を要求するが、同節が「`rotate-remap` は `jobs` 行も `operations` 行も持たない」と決めているため記録先が存在しない — `.thread/34/design.md:1066`
- [W-005] `cancel-reservation` の `status` 非依存削除 × 第5.2節 (c) の「`operationId` はログに出してよい」が同時成立し、完了済みアカウントの恒久ロックアウト原始関数になる — `.thread/34/design.md:456,501,914`
- [W-006] SSO 専用アカウントへリセットメールを送るか未決で、読み方により「メール到達性だけで SSO 専用アカウントにパスワードを設定できる」経路が開閉する — `.thread/34/design.md:1383-1392,942,1883`
- [W-007] 第3.2節の「新設する5つの秘密」「state 側の新設3秘密」が実数（4つ / state 側2つ）と合わない — `.thread/34/design.md:170,172,1945`
- [W-008] 第2.1節 F-1 が limits ページの表構造を「Workers Paid 列」と描写しているが、実際の表にプラン列は無い（不整合という結論自体は正しい） — `.thread/34/design.md:103`
- [W-009] #37 の入力として名指しされた `.thread/36/plan.md` / `.thread/36/adr.md` がリポジトリに1度も commit されていない — `.thread/34/design.md:1974,1984,1985`
- [W-010] `testing.md` 確認項目14 手順1 が期待結果「出力が空」を満たさない（実行して2件検出） — `.thread/34/testing.md:400-410,431`
- [W-011] `testing.md` 確認項目17 手順1 が期待結果「実測6件」を満たさない（実測7件。`spec/adr/005` が分類外） — `.thread/34/testing.md:502-503`

### Notes 由来で修正対象に含めるもの

- F-21 の changelog 日付（2026-06-30 → 実際は 2026-07-04）と F-5 の namespace API 一覧の欠落（`getByName` / `jurisdiction`） — do-boundary N-001
- 第5.5節 1 の locator 出所の例示が `operations.targetLocators` を覆っていない — do-boundary N-002
- 周期ジョブの初回投入点と `rotate-encryption` の再武装が未明示 — do-boundary N-003（B-002 / B-003 と同型）
