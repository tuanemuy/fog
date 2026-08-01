# PR Review #001 — docs: spec と CLAUDE.md を FTS5 全文検索 + Durable Objects 単独構成へ改訂する

**PR:** #46
**Date:** 2026-08-01
**Round:** 1回目

## Summary

- Blockers: 12（重複を束ねると 10）
- Warnings: 29（重複を束ねると 27）
- Notes: 44
- Verdict: **BLOCKED**

## レイヤー別ファイル

- 要件・シナリオ・ページ整合: review-001-requirements.md（B: 2 / W: 6）
- ドメイン・ユースケース: review-001-domain-usecase.md（B: 7 / W: 6）
- DB 設計・永続化アダプター: review-001-database.md（B: 1 / W: 6）
- テストケース・台帳・マニュアルテスト: review-001-testcases.md（B: 1 / W: 4）
- 設計正本との忠実性・CLAUDE.md・切り出し境界: review-001-design-fidelity.md（B: 1 / W: 7）

## カバレッジ

- 確認申告ゼロのファイル: **なし**（design-fidelity がスキップ 0 で 80 件全件を確認。他レイヤーの確認申告は requirements 33 / domain-usecase 70 / database 33 / testcases 70）

## 独立検出（2レイヤー以上が同じ問題を挙げたもの）

- **イベント名だけの期待値が knowledge のテストケース4行に残存** — domain-usecase B-001 と testcases B-001 が独立に検出
- **`userId スコープ` の残存** — domain-usecase B-002（20ファイル34行）と testcases W-002（18行）が独立に検出
- **`usableForLogin` 相当が `CredentialRef` に無い** — requirements B-001 と domain-usecase B-005 が独立に検出
- **不透明カーソルの期限切れ検証責任の矛盾** — requirements W-004 と domain-usecase B-007 が独立に検出

## 指摘一覧

### Blockers

- [B-001] `usableForLogin` 相当が `CredentialRef` に無く、P-13 の判定も `removeCredential` の不変条件も成立しない — `spec/domains/identity.md:52-58`（requirements B-001 / domain-usecase B-005）
- [B-002] 新設した画面約束（SSO 連携の解除 / AI 接続「すべて失効」）に対応するユースケースが無い — `spec/pages/index.md:68-69,224`（requirements B-002）
- [B-003] イベント名だけの期待値が残存 — `spec/testcases/knowledge/updateTopic.md:8,12` ほか3行（domain-usecase B-001 / testcases B-001）
- [B-004] `userId スコープ` が20ファイル34行残存。うち8ファイルは `coverage.md` が「影響なし」と誤判定 — `spec/inventory/test.md` ほか（domain-usecase B-002）
- [B-005] 期限切れ項目の列挙ポートが消えたまま代替が無い — `spec/usecases/trash.md:335`（domain-usecase B-003）
- [B-006] `purgeAfter` 一括再計算の書き込み経路がどのポートにも無い — `spec/usecases/identity.md:473`（domain-usecase B-004）
- [B-007] `executePasswordReset` に `sessionEpoch` 前進が無い（design.md:1331 が正本） — `spec/usecases/identity.md:241-242`（domain-usecase B-006）
- [B-008] 不透明カーソルの期限切れ判定が純関数 `SearchQuery.create` に置かれ実装不能 — `spec/domains/search.md:44`（domain-usecase B-007）
- [B-009] `credential_locators` / `credential_mappings` に主キー宣言が無い — `spec/database/index.md:93-119,511-580`（database B-001）
- [B-010] handoff 前方互換点2（コーディネーター予約行を終端の各段が終わるまで消さない）が `spec/` に無い — `spec/database/index.md:557-566`（design-fidelity B-001）

### Warnings

- [W-001] 読み取り専用ユースケースのテストに書き込み期待 — `spec/testcases/identity/listAiClientConnections.md:17`
- [W-002] `43シナリオ` が実測 39 と不一致 — `spec/index.md:12,21`
- [W-003] P-11 の「もっと読む」「カーソル期限切れ」がシナリオ・手順書に降りていない — `spec/pages/index.md:190,197`
- [W-004] 不透明カーソルの期限切れ検証責任がドメインとポートで矛盾 — `spec/domains/search.md`
- [W-005] 設計が渡した画面文言「試行が制限されている」が P-13 に無い — `spec/pages/index.md:226-229`
- [W-006] `TOPIC_NOT_FOUND` の画面状態が P-11 に無い — `spec/pages/index.md:194-197`
- [W-007] Directory 側書き込みのポートが不在 — `spec/domains/identity.md`
- [W-008] `credential_locators` 等が domain 側に契約を持たない — `spec/domains/identity.md:363-381`
- [W-009] `trashed ⇔ purgeAfter` の新不変条件にテストケースが1件も無い — `spec/testcases/trash/`
- [W-010] リセット系に旧語彙・旧契約が残存 — `spec/usecases/identity.md`
- [W-011] trash のユビキタス言語が旧「照会時算出」定義のまま、`isExpired` が呼び出し元を喪失 — `spec/domains/trash.md`
- [W-012] AI `delete` が `Memo.softDelete` の新シグネチャに未追随 — `spec/usecases/memo.md`
- [W-013] external-content FTS5 の `'delete'` が特殊コマンド構文である旨が spec に無い — `spec/database/index.md:404-405`
- [W-014] OCC の共通方針が `WHERE id = ? AND version = ?` と断定するが `account` / `user_settings` に `id` 列が無い — `spec/database/index.md:26`
- [W-015] 非集約ストア6つの書き込み口が `CLAUDE.md:68` にしか無く spec に0件 — `spec/domains/identity.md:363-381`
- [W-016] `jobs` の `done` / `poison` 行への再投入規則が spec 全域に無い — `spec/database/index.md:414,435-439`
- [W-017] 物理スキーマの決定（`search_entries` の PK 形）が `spec/domains/search.md` と二重管理 — `spec/domains/search.md:224-227`
- [W-018] `purge-trash` の再計算フェーズの自己消尽述語が spec に無い — `spec/database/index.md:447,494`
- [W-019] identity の中間状態語彙8語が上流ドメインに名前のアンカーを持たない — `spec/testcases/identity/changePassword.md` ほか
- [W-020] `userId スコープ` の書き換えた行と残した行が併存 — `spec/testcases/knowledge/createDocument.md:22` ほか（B-004 と同根）
- [W-021] マニュアルテストの TC 番号が文書内の並び順と不一致 — `spec/manual-tests/search.md:153` / `account.md:492`
- [W-022] 追加テストデータ D-A2 / D-A3 が TP-A 配下のため TC-04 の期待結果と同居の検証が無い — `spec/manual-tests/search.md:44`
- [W-023] `CLAUDE.md`「Key concepts」導入文が新規追加の項に対して嘘 — `CLAUDE.md:66`
- [W-024] 「ポートの同期契約」の例外理由が判定基準にならず `ArchiveWriter.write` と食い違う — `spec/domains/index.md:34`
- [W-025] 前方互換点3（`account.callerToken`）が肯定形だけで「それ以外では消さない」を言っていない — `spec/database/index.md:71`
- [W-026] ADR が自分に課した「PR 本文に明記する」が6件未履行 — `.thread/35/adr.md`
- [W-027] `README.md` が改訂後 `CLAUDE.md` と矛盾 — `README.md:53`
- [W-028] 「設計の表が挙げていない行に手を入れたのは3ファイル」が実際は4ファイル11行 — `.thread/35/step14-checklist.md:49`
- [W-029] AC-14 / AC-15 未達（ステップ18 未実行） — `.thread/35/steps.md`
