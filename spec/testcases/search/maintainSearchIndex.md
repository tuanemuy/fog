# テストケース: 同期検索射影

旧`maintainSearchIndex`は廃止した。このファイル名は参照安定性のため保持し、`SemanticCommitPort`とtransaction-scoped `SearchProjectionPort`のcontract testを定義する。

| Given | When | Then |
|---|---|---|
| 空のUser Data DO | memoをcreateする | 本体・初版revision・FTS entry・idempotency結果が同じtransactionで確定し、直後の検索にヒットする |
| active memo | bodyをupdateする | 本体/revision/FTS entryが同時に更新され、旧語は消え新語がヒットする |
| active memo | removeする | 本体のtrash状態とFTS removeが同時に確定し、直後からヒットしない |
| trashed memo | restoreする | 本体とFTS upsertが同時に確定し、直後からヒットする |
| 空のUser Data DO | documentをcreateする | 本体・revision・topic/source join・FTS entryが同時に確定する |
| active document | update/remove/restoreする | 各本体変更とFTS projectionが同時に反映される |
| memo/document create | 本体repositoryが失敗する | FTS/idempotencyを含む全変更がrollbackする |
| memo/document create | FTS projectionが失敗する | 本体/revision/source link/idempotencyを含む全変更がrollbackする |
| source link追加/削除 | semantic commandをcommitする | memo/document双方のsource DTOを同transactionで再射影する |
| topic archive/unarchive | commitする | 配下documentを削除せずarchived状態だけを更新する |
| topic trash/restore/hard delete | commitする | 配下documentのprojectionをremove/upsert/removeする |
| 完了済みoperationId | 同一payloadで再送する | 保存済み結果を返し、二重書き込みしない |
| 完了済みoperationId | 異なるpayloadで再送する | idempotency conflictで書き込まない |
| transaction callback | Promise/RPC/外部I/Oを渡そうとする | 型またはcontract testで拒否する |
| user A/B | 同じentity IDを各DOで作る | FTS tableは物理的に分離され、相互検索できない |

## workerd先行spike

実際のworkerd上でSQLite-backed DO、FTS5 trigram、transaction rollback、`bm25`/`snippet`、短語fallbackを検証する。trigramが利用不能なら実装を進めずtokenizer判断をADRへ戻す。

## local-only CLI

test worker + state auxiliary workerだけを経由し、memo/document create/update/remove/restoreと直後のsearchを確認する。CLI route/commandはproduction artifactへ含めない。
