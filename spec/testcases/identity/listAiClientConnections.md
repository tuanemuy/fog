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
| 前回のリセット完了より前に作られた接続と、それ以降に作られた接続の両方を保有する | パスワードリセットを完走したあと一覧を取得する | **`createdAtResetVersion` が前進前の `account.resetVersion` と等しい接続（= 前回のリセット完了以降に作られた接続）だけが `revoked` になり、それより古い接続は `active` のまま残る** | |
| 接続を作ったあとパスワードを変更し、その後にリセットを完走する | 一覧を取得する | 当該接続は `revoked` になる。**基準は `credentialVersion` ではなく `createdAtResetVersion` なので、あいだにパスワード変更が挟まっても失効の対象から外れない** | |
| active な接続を保有する | パスワードを変更する（リセットではない）だけで一覧を取得する | 接続は `active` のまま残る（`resetVersion` はリセット完了でのみ前進するため） | |
