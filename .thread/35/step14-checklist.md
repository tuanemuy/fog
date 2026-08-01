# ステップ14 適用チェックリスト — イベント期待の書き換え

設計 第11.1節「改訂する — テストケース」（`.thread/34/design.md:2394-2428`）の表と1対1で照合する。**行の順序は設計の表の順に揃えてある。**

- **(A)** イベント期待を projection の期待へ読み替える
- **(B)** イベント期待を落とす
- **(C)** ケースごと削除する
- **競合** 「並行する pruner」を「並行する `purge-trash` ジョブ」へ差し替える

「台帳」列は `spec/inventory/test.md` の要点欄をステップ15.5 で同期したか。`—` は当該行の要点欄にイベント / pruner 由来の記述が無く、同期の必要が無かったことを表す。

| # | ファイル | 行（改訂前） | 設計の指定 | 実際に適用したもの | 台帳 |
|---|---|---|---|---|---|
| 1 | `search/maintainSearchIndex.md` | 全体 | (C) ファイルごと削除 | (C)。`git rm`（ステップ13） | 済（`TC-maintainSearchIndex-*` 28件を削除） |
| 2 | `search/search.md` | `:12` / `:28` | 両方 (C)。`:28` の代わりに「投稿直後に必ずヒットする」を新設 | (C) 2件 + 新設ケースを末尾に append（ステップ13） | 済（`TC-search-006` / `-022` を欠番化、新設を採番） |
| 3 | `trash/pruneExpiredTrashItems.md` | `:7`〜`:22` | Alarm 前提へ全面書き換え。`:16` は (C)。`:8` は (A) | 全面書き換え。`:16`（ユーザー横断）を (C)。`:8` を (A)（同一 `transactionSync` の projection 更新）。起動契機を `purge-trash` ジョブの起床へ、`listExpiredItems` を自 DO の `purge_after` 索引へ、`batchSize` を `chunkLimit` / `hasMore` へ | 済（17件を書き換え、`TC-pruneExpiredTrashItems-010` を欠番化） |
| 4 | `trash/emptyTrash.md` | `:7` / `:12` / `:15` | `:7` (A) / `:12` 競合 / `:15` 同期 UoW | `:7` (A)。`:12` 競合を `purge-trash` ジョブへ。`:15` を `UnitOfWorkProvider.run`（同期コールバック）へ。**加えて `:10`**（`document.sourceLinksChanged` が発行される）を (A) — 設計の表が挙げていないが同じイベント期待である | 済（`TC-emptyTrash-001` / `-006`） |
| 5 | `trash/hardDeleteTrashItem.md` | `:17` / `:24` | `:17` 競合 / `:24` (B) | `:17` 競合を `purge-trash` ジョブへ。`:24` (B)。**加えて `:7` / `:8` / `:9` / `:11` / `:12`** のイベント名を持つ期待を (A) — 設計の表が挙げていないが `memo.hardDeleted` / `document.sourceLinksChanged` 等のイベント期待である | — |
| 6 | `trash/restoreDocument.md` | `:9` / `:36` / `:55` | `:9` / `:36` (A) / `:55` 競合 | `:9` / `:36` (A)。`:55` 競合を `purge-trash` ジョブへ。**加えて `:22` / `:24` / `:37`** のイベント収集期待を (A) | 済（`TC-restoreDocument-032`） |
| 7 | `trash/restoreMemo.md` | `:7` / `:9` / `:16` | `:9` (A) / `:7` `:16` (B) | 指定どおり | — |
| 8 | `trash/restoreTopic.md` | `:18` | 競合 | `:18` 競合を `purge-trash` ジョブへ。**加えて `:7` / `:10`** のイベント収集期待を (A) | — |
| 9 | `memo/postMemo.md` | `:9` / `:19` | `:9` (A) / `:19` (B) | 指定どおり | 済（`TC-postMemo-003`） |
| 10 | `memo/post_memo.md` | `:9` | (A) | 指定どおり | 済（`TC-post_memo-003`） |
| 11 | `memo/editMemo.md` | `:8` / `:10` / `:25` | `:8` (A) / 残り (B) | 指定どおり | — |
| 12 | `memo/update_memo.md` | `:8` / `:10` | `:8` (A) / `:10` (B) | 指定どおり | — |
| 13 | `memo/rollbackMemo.md` | `:8` / `:9` | `:8` (A) / `:9` (B) | 指定どおり | — |
| 14 | `memo/softDeleteMemo.md` | `:8` / `:17` | `:8` (A) / `:17` (B) | 指定どおり | 済（`TC-softDeleteMemo-002`） |
| 15 | `memo/delete.md` | `:8` / `:18` | `:8` (A) / `:18` (B) | 指定どおり | 済（`TC-delete-002`） |
| 16 | `knowledge/createTopic.md` | `:7` / `:20` | 両方 (B) | 指定どおり（トピックはエントリを持たないことを明記） | — |
| 17 | `knowledge/createDocument.md` | `:7` / `:29` | `:7` (A) / `:29` (B) | 指定どおり | — |
| 18 | `knowledge/editDocument.md` | `:7` / `:10` | `:7` (A) / `:10` (B) | 指定どおり | — |
| 19 | `knowledge/editDocumentByAi.md` | `:15` | (B) | 指定どおり。**加えて `:7`**（`document.edited` が記録される）を (A) — 設計の表が挙げていないが同じイベント期待である（B-001） | 済（`TC-editDocumentByAi-001`） |
| 20 | `knowledge/rollbackDocument.md` | `:7` / `:10` | `:7` (A) / `:10` (B) | 指定どおり | — |
| 21 | `knowledge/trashDocument.md` | `:7` / `:16` | `:7` (A) / `:16` (B) | 指定どおり | — |
| 22 | `knowledge/trashTopic.md` | `:7` / `:19` | `:7` (A) / `:19` (B) | 指定どおり。**加えて `:9`**（`document.trashed` は発行されない）を (B)（B-001） | 済（`TC-trashTopic-003`） |
| 23 | `knowledge/updateTopic.md` | `:7` `:10` `:11` `:13` `:14` `:15` `:28` | 全件 (B)。`:15` は「rename と archive が順に適用される」だけを残す | 指定どおり。`:7` にはトピック名が join で解決されることを補記。**加えて `:8`**（`topic.updated`）と **`:12`**（`topic.archived` / `topic.unarchived`）を (B)（B-001） | 済（`TC-updateTopic-002` / `-006`） |
| 24 | `identity/registerWithPassword.md` | `:7` / `:22` | 全件 (B) | (B)。あわせて `PasswordUser` / `SsoUser` / `UserRepository` をクレデンシャル集合と分割後リポジトリの語へ読み替え（ADR-019 の波及） | 済（`TC-registerWithPassword-001`） |
| 25 | `identity/registerOrLoginWithSso.md` | `:7` / `:9` | (B) + signup saga の phase 順 | (B)。phase 順（Directory 予約2本に勝ってから User Data DO を初期化）を `:7` に反映し、**予約の片方だけ敗北するケース**と**中間状態の観測ケース**を末尾に新設。巻き戻し手順は書かない（ADR-009） | — |
| 26 | `identity/revokeAiClientConnection.md` | `:7` / `:8` / `:12` / `:15` | `:8` は (C) + 置き換え、残り (B) | `:8` を (C)（行ごと削除）。置き換えケース「`status = 'revoked'` の次のリクエストで DO 内ガードが拒否する」を**末尾に append**（連番は欠番のまま） | 済（`TC-revokeAiClientConnection-002` を欠番化、置き換えを採番） |
| 27 | `identity/changePassword.md` | `:7` / `:19` | (B) + 中間状態3値 / `sessionEpoch` / 濫用抑止3件 / 終端 | (B)。新設 8 ケース（`changeState` の `'pending'` / `'advanced'` / `sessionEpoch` 前進 / 接続が失効しないこと / `failedAttempts` 前進 / `nextAttemptAllowedAt` 未到達の明示拒否 / `failedAttempts` のリセット / 終端後に旧パスワードで入れること）。**巻き戻す列の列挙・段構成・終端モードの印は書かない**（ADR-009） | — |
| 28 | `identity/executePasswordReset.md` | `:7` / `:22` | 同上 | (B)。新設 4 ケース（中間状態 / `sessionEpoch` 前進 / `resetVersion` 前進による直近世代の接続失効 / 終端後に旧パスワードで入れること）。**濫用抑止3件は足さない** — 旧パスワードの照合そのものが無い経路であり、`failedAttempts` を進める契機が存在しないため（ADR-027） | — |
| 29 | `identity/changeTrashRetentionDays.md` | `:7` / `:18` | (B) + `purge_after` 再計算と Alarm 張り直し | (B)。新設 2 ケース（同一トランザクションでの `purgeAfter` 再計算と起床の張り直し / 件数が大きい場合のチャンク分割と再計算フェーズ優先） | — |
| 30 | `identity/approveAiClientAuthorization.md` | `:9` / `:16` | (B) | (B)。`:9` に `createdAtResetVersion` の写しを補記 | — |
| 31 | `identity/denyAiClientAuthorization.md` | `:9` | (B)。括弧内の理由だけを残す | 指定どおり | — |
| 32 | `identity/logout.md` | `:9` | (B) | 指定どおり | — |

**設計の表は30ファイルを挙げているが、本チェックリストは32行ある。** 差の2行は `search/maintainSearchIndex.md` と `search/search.md`（ステップ13 の担当。設計では同じ表に載っている）で、ステップ14 の対象30ファイルはそれ以外の全部である。

**設計の表が挙げていない行に手を入れたのは7ファイル・15行**（#4 `emptyTrash.md:10` の1行 / #5 `hardDeleteTrashItem.md` の5行 / #6 `restoreDocument.md` の3行 / #8 `restoreTopic.md` の2行 / #19 `editDocumentByAi.md:7` の1行 / #22 `trashTopic.md:9` の1行 / #23 `updateTopic.md:8` `:12` の2行）。いずれも「`memo.hardDeleted` が収集される」のようにイベント名を直接書いており、`イベント` という語も `V-3` の走査語も含まないため設計の表のヒット行に現れなかった。第7.3節（イベントは transport としても業務表現としても残らない）に照らして (A) / (B) を適用した。

**このうち後半4行（#19 / #22 / #23）はレビュー 001 の B-001 で取り残しとして検出された分である。** 初版は前半11行だけを拾い上げて「3ファイル」と数え違えていた（`.thread/35/adr.md` ADR-028 の「4ファイル11行」も同じ数え違い。訂正は ADR-035）。イベント**名**を直接書いた期待値は `V-3` の走査語に1つも当たらないため、検出にはイベント名を直接走査する検査（`V-3b`）が要る（`.thread/35/testing.md` への追加は別担当）。
