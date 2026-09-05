# P4a core 独立検証

R16〜R18 の domain/application/libSQL/crypto は PASS。必須不具合なし。HTTP、UI、ブラウザ経路の合否は別 Verifier の報告と合わせて判断する。

## 対象と範囲

実施: 2026-09-05T12:04:00Z〜2026-09-05T12:11:13.580272Z。HEAD は `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。開始時 2026-09-05T12:05:29.593524Z に [P4a対象](../phases/P4a-target-hashes.json) の142件を照合し全一致。終了時の照合も142件全一致で、時刻は [hash記録](P4a-core-hash-check.json) に保存した。削除ファイルは不存在を一致として確認した。

元要件は spec/requirements.md §4.3〜4.5/5.2、spec/scenario/account.md S-AC-05/06、spec/scenario/ai.md S-AI-01〜06。brief/design/plan と P4a/P4a-core 完了候補を照合した。製品コードと既存テストは変更していない。検証は専用の一時 SQLite DB のみを使用し、ブラウザ、サーバー、開発 DB を操作していない。

## 要件別結果

| ID | 結果 | 根拠 |
| --- | --- | --- |
| R16 | core PASS | 登録済み client と redirect 完全一致、S256、request の human owner 初回拘束と再拘束拒否、decision の主体一致、state保持・拒否・消費済み拒否をコードと実DBで確認。request10分/code2分/token30日のちょうど期限を拒否。code は client/redirect/challenge/owner に拘束され、誤った交換で消費しない。単一DB clientと独立OS process双方で同時交換は成功1件だけ。接続の所有者別一覧・最終利用・失効、別ownerの失効拒否を確認。request/code/token の秘密は hash のみ、bearer は human session 認証不可。 |
| R17 | core PASS | 7 read/8 write の明示列挙を確認。AIメモ作成/置換、トピック作成/更新/完了、出典付き文書作成、単体/一覧/最近メモ/共通検索、三種softDeleteを実DBで確認。patch は版・一意完全一致・重複/overlap拒否・理由・本文全体置換拒否、rewrite は明示trueと理由必須。AI名・時刻・理由の履歴を保持。content/revision/ledger/lastUsed は scoped services と同じUoWで確定。永続冪等性はconnection＋key hash＋canonical operation/input hashで拘束し、差異は拒否。並行、別client、別process、新process再送で一回だけ更新。 |
| R18 | core PASS | ownerはtokenのconnectionから生成し、各repositoryの所有者付き条件と参照検査で隔離。明示operation外を拒否し、履歴/rollback/trash/restore/hardDelete/emptyTrash/settings/exportの全human専用core APIもruntime AI actorを拒否。AI安全DTOから削除sourceとdeleted属性を除外し、共通検索は削除対象・source IDを除外。ledgerは本文/タイトル/旧DTOを保存せず、replayは現在稼働中kind/id/versionまたはnullのみ。soft/hard delete後のreceiptに対象metadataなし。復元後のdelete replayはmemo/topicとも再削除しない。失効後はread/fresh write/replayすべて拒否。 |

## 実行結果

- `pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__`: 4 files / 54 tests PASS、2026-09-05T12:05:30Z、16.30秒。[log](P4a-core-integration.log)。既存実装者テストを独立実行した。
- `pnpm exec vitest run --config .goal-implement/reviews/P4a-core-vitest.config.ts`: 1 file / 4 tests PASS、2026-09-05T12:09:07Z、3.16秒。[独立harness](P4a-core-independent.test.ts)、[config](P4a-core-vitest.config.ts)、[子process](P4a-core-worker.ts)、[log](P4a-core-independent.log)。

独立追加検証は次の4件。

1. 本番と同じ WAL/foreign_keys/busy_timeout=5000 を持つ別OS process二つから、同一codeを交換。成功1件、他方INVALID_AI_CODE、code消去、接続増分1件を確認。交換前のcode tableにcodeとverifierの平文がないことも確認。
2. 同じ設定の別OS process二つから同一key/payloadを書き込み、一つのrequestId、一つのmemo/revision/ledgerのみを確認。終了後に新しいprocessから同要求を再送し同requestId/replayedを確認。
3. document revision INSERTの故障で本文/版/履歴/ledger/lastUsedをrollback。故障解除後の同key再試行は成功。topicセット削除後のledger INSERT故障でtopicと配下document・trash・lastUsedが元に戻ることを確認。成功後、人間がセット復元し同deleteを再送しても配下documentを再削除せず履歴を保持。
4. 全human専用core APIのruntime AI actor拒否。接続失効後に既存key replay、新規key書込、最近メモ、guidanceをすべて拒否し、追加memoがないことを確認。

初回の独立harnessは CJS `require` で作成したclientとESM adapterの `LibsqlError` の同一性が異なり、注入障害を期待したSTORAGE_CONFLICTではなくDATABASE_ERRORとして受け取った。harnessを製品テストと同じESM解決へ合わせて再実行し、上記4件が成功した。製品コードの変更で解決したものではない。

## レビュー根拠と限界

`aiServices.ts` は認可、失効検査、canonical ledger照合を一つのUoWで制御し、`aiOperations.ts` のscoped providerが既存usecaseを同じtransactionに束ねる。`unitOfWork.ts` は write transaction を使いadapter内でbusy/lockedをretryする。`aiRepository.ts` とschemaのconnection/key複合主キー、code/request消費が並行時にも実DBで成立した。

domainの `patchedDocument` は `indexOf(find, first + 1)` により重なった一致も拒否し、`revisionReason` はAIの空理由を拒否する。共有content repositoriesはownerとdeletedを絞り込み、AI投影はさらに墓標属性自体を落とす。current receiptは稼働中repositoryの検索だけを使う。処理対象の秘密値や本文を検証報告へ保存していない。

この報告はcore受け入れの根拠であり、HTTP cookie/bearer境界・認可UI・ブラウザ操作・root checkの再実行は担当範囲外。プロジェクト全体完了を宣言するものではない。core範囲の未検証必須項目と再現不具合はない。
