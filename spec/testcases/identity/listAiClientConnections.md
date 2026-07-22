# テストケース: listAiClientConnections

[usecases/identity.md](../../usecases/identity.md) の listAiClientConnections に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ユーザーが active な接続を複数保有 | 一覧を取得する | 全接続が `connectedAt` 降順で返る。各要素に `connectionId` / `clientName` / `status: "active"` / `connectedAt` / `lastUsedAt` が含まれ、`revokedAt` は null | |
| ユーザーが接続を1件も持たない | 一覧を取得する | 空配列が返る（エラーではない） | |
| ユーザーが active と revoked の接続を混在して保有 | 一覧を取得する | 失効済み接続も事実として含まれて返る。revoked の要素は `status: "revoked"` かつ `revokedAt` が非 null（一覧に出すかは UI の判断） | |
| 未使用の接続（トークンで一度も API が呼ばれていない） | 一覧を取得する | 該当接続の `lastUsedAt` は null | |
| API 利用済みの接続（`recordUsage` 実行済み） | 一覧を取得する | 該当接続の `lastUsedAt` に最終利用日時が入る | |
| ユーザー A とユーザー B がそれぞれ接続を保有 | ユーザー A の `userId` で一覧を取得する | ユーザー A の接続のみが返る（他ユーザーの接続は含まれない） | |
| `AiClientConnectionRepository.listByUserId` で DB 例外が発生する | 一覧を取得する | `SystemError` | |
