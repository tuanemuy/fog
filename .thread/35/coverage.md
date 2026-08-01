# カバレッジ台帳 — Issue #35

`.thread/34/design.md` 第11.1節「走査の方法」の4手段を再実行し、`spec/` の非レビュー Markdown **全数に判定を付けた**もの。1行 = 1ファイルで、着手前の **101 行すべてを埋めてある**。**本ラウンドの新設3ファイルを加えて台帳は 104 行**になり、うち1行（`spec/testcases/search/maintainSearchIndex.md`）は削除済みファイルの記録である。

**再走査の実測（2026-08-01）。** 設計 第11.1節と完全に一致した。

| 指標 | 設計 第11.1節 | 本 Issue の再実測 |
|---|---|---|
| 非レビュー Markdown | 101 ファイル | 101 ファイル |
| 手段1（語彙走査）のヒット | 62 ファイル | 62 ファイル |
| 未ヒット（手段2〜4 の対象） | 39 ファイル | 39 ファイル |

**判定の内訳は 改訂 80 / 新設 3 / 削除 1 / 影響なし 20 の計 104 行である。** 設計は「改訂 72 件 / 影響なし 29 件」で、**設計の判定を上書きしたのは 9 件**である。

- `spec/manual-tests/index.md` の1件（adr.md **ADR-010**。件数表と実行記録の分母が本 Issue 自身の編集で動くため、「影響なし」→「改訂（ステップ16.5）」）
- 読み取り専用ユースケースのテストケース **8 件**（adr.md **ADR-036**。いずれも本文に旧テナント分離機構（`userId スコープ`）を持つので「影響なし」は誤判定だった。「影響なし」→「改訂（ステップ14）」）

残りは設計の判定をそのまま写した。**新設3ファイルは設計の一覧にそもそも載っていない**ので上書きではなく追加である。

**完了後のファイル数は 103 になる。** 内訳は着手前 101 − 削除1（`spec/testcases/search/maintainSearchIndex.md`。adr.md ADR-003）+ 新設3（`spec/testcases/identity/{revokeAllAiClientConnections,unlinkSsoCredential,linkSsoCredential}.md`。adr.md ADR-051 / ADR-059 / ADR-062）である。それ以外の追加はすべて既存ファイルへの節・行の追加として現れる。**台帳の行数（104）がファイル数（103）と一致しないのは、削除済みファイルの行を記録として残すためである。**

## 再現手順

```bash
find spec -name '*.md' | grep -v '/review/' | sort > /tmp/all.txt
grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド|collectEvents|pruner|D1|libSQL|Turso|Vectorize|RRF|PendingBatch|occ_guard|UnitOfWork|indexer|embedding|イベント|Queue' \
  spec --include='*.md' | grep -v '/review/' | sort > /tmp/hits.txt
comm -23 /tmp/all.txt /tmp/hits.txt   # 39 件
```

**除外は `spec/**/review/` の 39 ファイルだけである**（adr.md ADR-007）。`spec/idea.md` は除外しない。

## 判定台帳

「拾った手段」は設計 第11.1節の4手段に対応する — 手段1 は語彙走査、手段2 はポート定義の目視、手段3 はマニュアルテストの環境前提の目視、手段4 は本設計が足した振る舞いからの逆引きである。

| ファイル | 判定 | 対応ステップ | 拾った手段 |
|---|---|---|---|
| `spec/adr/001-restore-document-without-topic.md` | 影響なし | — | 4 |
| `spec/adr/002-export-scope.md` | 影響なし | — | 4 |
| `spec/adr/003-source-link-after-hard-delete.md` | 影響なし | — | 4 |
| `spec/adr/004-domain-boundaries.md` | 影響なし | — | 1 |
| `spec/adr/005-search-index-via-outbox.md` | 影響なし | — | 1 |
| `spec/adr/006-memo-fulltext-update.md` | 影響なし | — | 4 |
| `spec/database/index.md` | 改訂 | 10 / 11 | 1 |
| `spec/design/icons/logo.md` | 影響なし | — | 4 |
| `spec/design/index.md` | 影響なし | — | 4 |
| `spec/design/tokens.md` | 影響なし | — | 4 |
| `spec/domains/export.md` | 改訂 | 7 | 2 |
| `spec/domains/identity.md` | 改訂 | 7 | 1 |
| `spec/domains/index.md` | 改訂 | 6 | 1 |
| `spec/domains/knowledge.md` | 改訂 | 7 / 11 | 1 |
| `spec/domains/memo.md` | 改訂 | 7 / 11 | 1 |
| `spec/domains/search.md` | 改訂 | 5 / 11 | 1 |
| `spec/domains/trash.md` | 改訂 | 7 | 1 |
| `spec/idea.md` | 改訂 | 2 | 1 |
| `spec/index.md` | 改訂 | 11 / 16.5 | 1 |
| `spec/inventory/adapter.md` | 改訂 | 12 | 1 |
| `spec/inventory/domain.md` | 改訂 | 12 | 1 |
| `spec/inventory/frontend.md` | 改訂 | 12 | 4 |
| `spec/inventory/test.md` | 改訂 | 15.5 | 1 |
| `spec/inventory/usecase.md` | 改訂 | 12 | 1 |
| `spec/issues.md` | 影響なし | — | 4 |
| `spec/manual-tests/account.md` | 改訂 | 15 | 4 |
| `spec/manual-tests/ai.md` | 改訂 | 16 | 1 |
| `spec/manual-tests/document.md` | 改訂 | 16 | 3 |
| `spec/manual-tests/index.md` | 改訂（ADR-010 で設計の判定を上書き） | 16.5 | 4 |
| `spec/manual-tests/search.md` | 改訂 | 16 | 1 |
| `spec/manual-tests/settings.md` | 改訂 | 16 | 3 |
| `spec/manual-tests/timeline.md` | 改訂 | 16 | 1 |
| `spec/manual-tests/trash.md` | 改訂 | 16 | 1 |
| `spec/pages/index.md` | 改訂 | 4 | 1 |
| `spec/requirements.md` | 改訂 | 2 | 1 |
| `spec/scenario/account.md` | 改訂 | 15 | 4 |
| `spec/scenario/ai.md` | 改訂 | 3 | 1 |
| `spec/scenario/document.md` | 影響なし | — | 4 |
| `spec/scenario/index.md` | 改訂 | 3 | 1 |
| `spec/scenario/search.md` | 改訂 | 3 | 1 |
| `spec/scenario/settings.md` | 影響なし | — | 4 |
| `spec/scenario/timeline.md` | 影響なし | — | 4 |
| `spec/scenario/trash.md` | 影響なし | — | 4 |
| `spec/testcases/export/exportAllData.md` | 改訂 | 15 | 4 |
| `spec/testcases/identity/approveAiClientAuthorization.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/changePassword.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/changeTrashRetentionDays.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/denyAiClientAuthorization.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/executePasswordReset.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/getCurrentUser.md` | 改訂 | 15 | 4 |
| `spec/testcases/identity/linkSsoCredential.md` | **新設**（ADR-062 / ADR-059） | 14 | — |
| `spec/testcases/identity/listAiClientConnections.md` | 改訂 | 15 | 4 |
| `spec/testcases/identity/loginWithPassword.md` | 改訂 | 15 | 4 |
| `spec/testcases/identity/logout.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/registerOrLoginWithSso.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/registerWithPassword.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/requestPasswordReset.md` | 改訂 | 15 | 4 |
| `spec/testcases/identity/revokeAiClientConnection.md` | 改訂 | 14 | 1 |
| `spec/testcases/identity/revokeAllAiClientConnections.md` | **新設**（ADR-051 / ADR-059） | 14 | — |
| `spec/testcases/identity/unlinkSsoCredential.md` | **新設**（ADR-051 / ADR-059） | 14 | — |
| `spec/testcases/knowledge/createDocument.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/createTopic.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/diffDocumentRevisions.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/knowledge/editDocument.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/editDocumentByAi.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/getDocument.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/knowledge/getTopic.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/knowledge/listDocumentRevisions.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/knowledge/listDocumentSourceMemos.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/knowledge/listDocumentsReferencingMemo.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/knowledge/listTopics.md` | 影響なし | — | 4 |
| `spec/testcases/knowledge/rollbackDocument.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/trashDocument.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/trashTopic.md` | 改訂 | 14 | 1 |
| `spec/testcases/knowledge/updateTopic.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/delete.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/diffMemoRevisions.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/memo/editMemo.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/get.md` | 影響なし | — | 4 |
| `spec/testcases/memo/getTimeline.md` | 改訂（ADR-036 で設計の判定を上書き） | 14 | 4 |
| `spec/testcases/memo/jumpToDate.md` | 影響なし | — | 4 |
| `spec/testcases/memo/listMemoRevisions.md` | 影響なし | — | 4 |
| `spec/testcases/memo/postMemo.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/post_memo.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/recent_memos.md` | 影響なし | — | 4 |
| `spec/testcases/memo/rollbackMemo.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/showMemoInTimeline.md` | 影響なし | — | 4 |
| `spec/testcases/memo/softDeleteMemo.md` | 改訂 | 14 | 1 |
| `spec/testcases/memo/update_memo.md` | 改訂 | 14 | 1 |
| `spec/testcases/search/maintainSearchIndex.md` | **削除** | 13 | 1 |
| `spec/testcases/search/search.md` | 改訂 | 13 | 1 |
| `spec/testcases/trash/emptyTrash.md` | 改訂 | 14 | 1 |
| `spec/testcases/trash/hardDeleteTrashItem.md` | 改訂 | 14 | 1 |
| `spec/testcases/trash/listTrash.md` | 改訂 | 15 | 4 |
| `spec/testcases/trash/pruneExpiredTrashItems.md` | 改訂 | 14 | 1 |
| `spec/testcases/trash/restoreDocument.md` | 改訂 | 14 | 1 |
| `spec/testcases/trash/restoreMemo.md` | 改訂 | 14 | 1 |
| `spec/testcases/trash/restoreTopic.md` | 改訂 | 14 | 1 |
| `spec/usecases/export.md` | 改訂 | 9 | 1 |
| `spec/usecases/identity.md` | 改訂 | 9 | 1 |
| `spec/usecases/knowledge.md` | 改訂 | 9 / 11 | 1 |
| `spec/usecases/memo.md` | 改訂 | 9 | 1 |
| `spec/usecases/search.md` | 改訂 | 8 / 11 | 1 |
| `spec/usecases/trash.md` | 改訂 | 9 / 11 | 1 |

## 判定の根拠が設計と異なる箇所

- `spec/manual-tests/index.md` — 設計 `design.md:2487` は「件数表と推奨実行順序だけを持つ」ことを理由に影響なしと判定しているが、その判定は件数が動かないことを前提にしている。ステップ15 が `spec/manual-tests/account.md` に、ステップ16 が `spec/manual-tests/search.md` にケースを足すので前提が崩れる（adr.md ADR-010）。
- **読み取り専用ユースケースのテストケース 8 件** — `spec/testcases/knowledge/{diffDocumentRevisions,getDocument,getTopic,listDocumentRevisions,listDocumentSourceMemos,listDocumentsReferencingMemo}.md` / `spec/testcases/memo/{diffMemoRevisions,getTimeline}.md`。設計は「`userId` スコープの読み替えは `spec/domains/index.md` の改訂で一括して効く」ことを理由に影響なしと判定しているが、**この8ファイルは本文に旧テナント分離機構（`userId スコープ`）を直接持つ**ので、上流だけを直すと同じ保証の説明が corpus 内で2通りになる。到達可能性の表現へ書き換えた（adr.md ADR-036）。
- **新設3ファイル** — `spec/testcases/identity/{revokeAllAiClientConnections,unlinkSsoCredential,linkSsoCredential}.md`。設計の一覧に無い（ユースケース自体が本ラウンドの新設である）。`spec/testcases/` の「1ユースケース1ファイル」構成を保つための追加で、上書きではない（adr.md ADR-051 / ADR-059 / ADR-062）。`linkSsoCredential` はレビュー2R で足した3件目で、`unlinkSsoCredential` の正常系に到達する唯一の経路を作るための新設である。

## 検証

```bash
find spec -name '*.md' | grep -v '/review/' | sort \
  | while read -r f; do grep -q "$f" .thread/35/coverage.md || echo "NO-VERDICT: $f"; done
```

期待は 0 行である。
