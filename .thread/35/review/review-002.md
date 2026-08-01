# PR Review #002 — docs: spec と CLAUDE.md を FTS5 全文検索 + Durable Objects 単独構成へ改訂する

**PR:** #46
**Date:** 2026-08-01
**Round:** 2回目

## Summary

- Blockers: 12
- Warnings: 24
- Notes: 23
- Verdict: **BLOCKED**

## レイヤー別ファイル

- 要件・シナリオ・ページ整合: review-002-requirements.md（B: 1 / W: 4）
- ドメイン・ユースケース: review-002-domain-usecase.md（B: 4 / W: 8）
- DB 設計・永続化アダプター: review-002-database.md（B: 2 / W: 5）
- テストケース・台帳・マニュアルテスト: review-002-testcases.md（B: 2 / W: 2）
- 設計正本との忠実性・CLAUDE.md・切り出し境界: review-002-design-fidelity.md（B: 3 / W: 5）

## カバレッジ

- 確認申告ゼロのファイル: **なし**（design-fidelity がスキップ 0 で 97 件全件を確認。他レイヤーは requirements 36 / domain-usecase 87 / database 86 / testcases 68+14）

## このラウンドの性質

**指摘 36 件のうち大半が「1ラウンド目の並列修正どうしが噛み合っていない」型。** `.thread/34/handoff.md` 第4節が「#34 では機械検査を設計できなかった」と명言した残余リスクが、そのままの形で現れた。個別の設計判断の誤りではなく、**担当境界をまたぐ伝播漏れ**が支配的である。

このため2ラウンド目の修正は**上流（契約）→ 下流（派生物）の2波に分ける**（1ラウンド目の5並列を繰り返さない）。

## 機械ゲートは全項目パス

`V-1`〜`V-10` 全 0 行 / `P-1`〜`P-11` 全通過 / `#L` 814 件全数検証 / 台帳⇔testcases 全単射 / ID 欠番規約適合 / 件数同期（53 / 814 / 39 / 201）/ ファイル数 102 / スコープ逸脱 0 行 / ADR-001〜060 重複0・欠番0 / #44・#45 の射程侵犯 0 件 / handoff 第3節の「残すもの」7項目と前方互換点4点は全数着地。

**残る指摘はすべて機械検査に掛からない意味論の破れである。**

## 指摘一覧

### Blockers

- [B-001] リセット完了画面（未ログイン）の必須導線に対し、受け皿の4ユースケースが全て「セッション由来の `userId`」を要求しており実装経路が無い — `spec/pages/index.md:66-69` / `spec/usecases/identity.md`（requirements B-001）
- [B-002] 新設 `unlinkSsoCredential` の正常系が構造的に到達不能（既存アカウントへ SSO 連携を追加する経路が存在しない） — `spec/usecases/identity.md`（domain-usecase B-002）
- [B-003] `purge-trash` の起床を張る投入点が、ソフトデリートの4ユースケースのどこにも無い（最初の完走で Alarm が恒久停止する） — `spec/usecases/memo.md:394-397,573` / `spec/usecases/knowledge.md:534-535,267-268`（domain-usecase B-001）
- [B-004] `jobs` の投入点の全数を持つはずの `kind` 全数表に「投入点」欄が無い。`sweep-orphan-mapping` の投入点は spec 全域 0 件 — `spec/database/index.md:452`（domain-usecase B-003）
- [B-005] `CLAUDE.md:43` の Layers 節に `domain events` が残存（`V-3` / `V-9` のどちらにも構造的に掛からない位置） — `CLAUDE.md:43`（domain-usecase B-004）
- [B-006] `jobs.operation_key` が「単一 TEXT 主キー = UUIDv7」の例外に載っておらず、字義どおり実装すると収束規則と冪等キーの決定的導出が全滅する — `spec/database/index.md`（database B-001）
- [B-007] `payload_digest` の「違う payload は `ConflictError`」と収束規則 (2)(3) が同じ入力に逆の指示 — `spec/database/index.md:453`（database B-002）
- [B-008] W-024（ポートの同期契約の例外理由）の合意済み `fix` が適用先3箇所に届いていない — `CLAUDE.md:114` / `spec/inventory/domain.md:32,36`（design-fidelity B-001）
- [B-009] `CLAUDE.md:68` が同ラウンドで採択した ADR-054「員数は書かない」に正面から違反 — `CLAUDE.md:68`（design-fidelity B-002）
- [B-010] 廃止済み機構「insert の一意制約違反」が残存（`user_settings` に一意制約は無く原理的に起きない） — `spec/usecases/identity.md:60,111` / `spec/manual-tests/account.md:580`（design-fidelity B-003）
- [B-011] 新設2ユースケースが `spec/manual-tests/account.md` のカバレッジ表に1行も無い — `spec/manual-tests/account.md`（testcases B-001）
- [B-012] `spec/manual-tests/trash.md` の期限テストが `trashedAt` 書き換え駆動のままで、本 PR が変えた「権威は保存済み `purgeAfter`」と矛盾（実行しても期待に到達しない） — `spec/manual-tests/trash.md`（testcases B-002）

### Warnings

- [W-001] P-11 の `TOPIC_NOT_FOUND` 状態が `spec/inventory/frontend.md` に降りていない — `spec/inventory/frontend.md:55`
- [W-002] `revokeAllAiClientConnections` の「設定画面からも呼べる」が P-13 / 台帳に導線を持たない — `spec/usecases/identity.md:459`
- [W-003] P-13 の「保有クレデンシャル一覧（SSO 解除つき）」に上流シナリオが無い — `spec/pages/index.md:225`
- [W-004] S-AC-07 の手順順序が実体験と逆 — `spec/scenario/account.md:73-75`
- [W-005] `Topic.softDelete/restore` の projection 影響欄が出典メモへのファンアウト欠落 — `spec/domains/knowledge.md`
- [W-006] trashTopic・AI delete のテストケースが同ファンアウトを期待していない — `spec/testcases/`
- [W-007] `changePassword` 正常系に `credentialVersion` 前進の期待が無い — `spec/testcases/identity/changePassword.md`
- [W-008] `listTrash` / `emptyTrash` で「ユーザー不在→NotFound」を生む手順が消えたのに行が残存 — `spec/usecases/trash.md`
- [W-009] 終端テストケース2件が #45 の巻き戻しを先取り — `spec/testcases/identity/`
- [W-010] リセット完了時の AI 接続一括失効に呼び出すポートの名指しが無い — `spec/usecases/identity.md`
- [W-011] knowledge の参照型一覧に `TrashRetentionDays` が無い — `spec/domains/knowledge.md`
- [W-012] `registerWithPassword` の DB 例外ケースが別境界の予約行まで巻き戻ると読める — `spec/testcases/identity/registerWithPassword.md`
- [W-013] `:460`「材料の寿命は #45 が決める」と同ファイルが書いた材料寿命規則3本が矛盾 — `spec/database/index.md:460`
- [W-014] 主要クエリ対応表 `:819` が rowid PK 化に追随していない — `spec/database/index.md:819`
- [W-015] PK へ昇格した `cl_credential_uq` / `cm_credential_uq` が索引表に `*_uq` のまま残り二重索引になる — `spec/database/index.md`
- [W-016] `account` の OCC `version` に書き手が無い — `spec/database/index.md` / `spec/domains/identity.md`
- [W-017] `purge-trash` の再計算フェーズが無界（3者不一致） — `spec/database/index.md:461` / `spec/usecases/trash.md:334` / `spec/domains/trash.md:258`
- [W-018] `spec/inventory/test.md:5` の「連番はテーブルの行順に対応する」が欠番導入で偽 — `spec/inventory/test.md:5`
- [W-019] `manual-tests/account.md` TC-40 の「先送り幅には上限がある」が `spec/` に根拠なし — `spec/domains/identity.md`
- [W-020] ADR-056 の決定が `CLAUDE.md:66` に未反映 + ADR 本文が削除済み Outbox 項を数えている — `CLAUDE.md:66` / `.thread/35/adr.md`
- [W-021] `CLAUDE.md:68` の名簿が2つの DO クラスのストアを1文に混在 — `CLAUDE.md:68`
- [W-022] `CLAUDE.md:69` の OCC 形が単一行テーブルに当てはまらない — `CLAUDE.md:69`
- [W-023] `CLAUDE.md:66` の英文が主述の数で崩れている — `CLAUDE.md:66`
- [W-024] `plan.md` の baseline `782` が実測 `771` — `.thread/35/plan.md`
