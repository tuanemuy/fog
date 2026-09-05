# P4a core 完了候補

対象は R16〜R18。core の実装・実DB検証の完了候補であり、独立受け入れ前。Web/HTTP境界・ブラウザ・開発クライアントは親 Implementer が担当する。

## 実装

- 登録済みclientの完全一致redirect URI、PKCE S256、10分認可要求、2分単回code、30日opaque bearerを実装した。request/code/tokenはhashだけを保存する。HTTPSまたはloopback HTTPを許可し、credentials・fragment・予約済みcallback queryを拒否する。
- 認可画面の取得でhuman ownerを初回拘束する。未拘束のdecision、他humanによる表示/decision、期限切れ、consumed requestを拒否する。stored URIへstateを保持し、許可はcode、拒否はaccess_deniedを返す。
- 接続一覧は所有者の有効な接続名・作成日時・最終利用日時・期限を返す。失効をすべてのAI操作とreplayの冒頭で確認する。AI bearerはhuman session認証に通らない。
- 読み取り7操作、書き込み8操作を明示列挙した。メモ最近/単体、トピック一覧/単体、文書単体、共通検索、guidanceと、メモ作成/置換、topic作成/更新、文書作成/patch/rewrite、三種softDeleteに対応する。
- AI専用DTOは稼働中の出典だけを投影し、human墓標DTOのdeleted属性を含めない。履歴・ゴミ箱・復元・完全削除・設定・exportを操作として公開せず、human専用関数はruntime actor検査も行う。
- patchはexpectedVersion・一意な完全一致（重複/重なりも拒否）・変更理由を要求する。本文全体を置換するpatchも拒否する。rewriteはconfirmRewrite:trueと変更理由を要求し、既存revisionを保持する。
- 全書き込みはconnectionごとの必須idempotencyKeyとcanonical payload hashを記録する。content mutation・revision・ledger・最終利用日時を同じUoWで確定する。scoped providerで既存usecaseを再利用し、入れ子のDB transactionを作らない。
- ledgerは本文・タイトル・過去DTOを保存しない。応答はreceiptと現在稼働中のresource kind/id/versionだけを返す。削除後はresource:null、失効後は拒否する。delete replayは復元された項目を再削除しない。

## 検証

- `pnpm --filter @repo/core typecheck`: 成功。
- scoped `pnpm exec biome check --write` / 最終 `biome check`: 28ファイル成功。
- `pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__`: 4 files / 54 tests 成功。AI追加22件、既存fog32件。
- PKCE標準vector、認可主体拘束、state保持、deny、各期限境界、不正redirect/client/PKCE、code再利用と同時交換を実SQLiteで確認した。
- 全操作、所有者隔離、理由/版/部分一致/明示rewrite、AI actor履歴、softDeleteからhuman復元、deleted sourceの全取得/検索/replayからの排除を確認した。
- 同一clientと別SQLite clientの並行要求、service/DB再オープン後replay、object key order非依存のpayload比較、key再利用差異、別connection scopeを確認した。
- ledger INSERT障害でcontent/revision/最終利用がrollbackし、同keyで再試行できることを確認した。schema反復migrationでP3設定・trash・history・AI token/ledgerを保持した。
- 別SQLite clientを同一JS event loopで同時実行するfixtureだけbusy_timeout=0とし、adapter retryでcommitを進める。同期driverの5秒busy waitはそのevent loopのpeer commitを止めるため。通常fixtureはproductionと同じWAL・foreign_keys・busy_timeoutを使用する。

## 引き継ぎ

`aiTypes.ts` がHTTP/UI契約、`createFogServices` の任意 `aiClients` が登録済みclient registry（未設定は接続開始を許可しない）。既存 `migrateFog` がAI tablesを追加する。外部送信・server/browser操作は行っていない。root checks・HTTP cookie/bearer境界・ブラウザ認可と接続失効の受け入れは親担当。

coreの既知の機能不具合・未完了項目なし。全体goal・Manager台帳は変更していない。対象コード書き込みと実行中検証を停止し、独立検証または具体的な修正依頼を待つ。

## 対象記録

日時: 2026-09-05T11:48:54.330161+00:00

HEAD: `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。既存P1〜P3未コミット成果を含む対象全体を記録する。

| ファイル | SHA-256 |
| --- | --- |
| `packages/core/src/adapters/fog/__tests__/ai.integration.test.ts` | `e162cb7d15a36c4329947f41d0305c702ec24c47cc7c98f9d2836a71bab05925` |
| `packages/core/src/adapters/fog/__tests__/content.integration.test.ts` | `8bcc832ce9ef8237dc4245d97ea3e3d71c21e204af3f5adcd34e67603c8bb3b0` |
| `packages/core/src/adapters/fog/__tests__/data.integration.test.ts` | `84be18bd96beda3b8afa33a2ae2e79c1750cde9f245a9b1a0ebd66650f8ff179` |
| `packages/core/src/adapters/fog/__tests__/services.integration.test.ts` | `7d0596b459f471e134c91267dede92d29fb9e9209c5d43dc7fd8950b7ac4a66c` |
| `packages/core/src/adapters/fog/aiRepository.ts` | `36a8155b75375f3beb16d97ba4d4cbb9cee5ce5b67814daf9f2f6ff4cdaa6c6e` |
| `packages/core/src/adapters/fog/contentRepositories.ts` | `e5373f477573dfef39a0f1afb6913c61ae5a3cd1c63b532cbf2336029db330f4` |
| `packages/core/src/adapters/fog/crypto.ts` | `f6abc4fdd250d62b7bf6ed06b74b746ea8916049c4c13c7b0e8047735c36cb0e` |
| `packages/core/src/adapters/fog/dataRepository.ts` | `554dbcb9ed3a1d3f99df9786fb9d0f97234702d783b82bc346430d43d7258f76` |
| `packages/core/src/adapters/fog/schema.ts` | `5f6d1fb49ad788fa36d6fdc44802e12b3bc615297e677842e438dd8f38957620` |
| `packages/core/src/adapters/fog/unitOfWork.ts` | `4de6937a60acd2f5a84c9aef0b2724931eb88ec138cbbb332c99a13fff13a3e4` |
| `packages/core/src/application/fog/aiOperations.ts` | `7132c25f3f5bc3c0aea06406d016d7e95ea76604333314fa63ca198709f689bd` |
| `packages/core/src/application/fog/aiPorts.ts` | `ea5aa2f1f3fbe91868626db7f5dd729d2c62d61504d7cb5a05f8db5da18f769c` |
| `packages/core/src/application/fog/aiServices.ts` | `f267dc21afb0c2158d447a93a24a91cb4b999dee3733b6fe3b4bf1ac8643a013` |
| `packages/core/src/application/fog/aiTypes.ts` | `d0b65ba1fb0f25cb720fa00e1e3c0ba25d3c23452e4e0b1592c4dc56e8416669` |
| `packages/core/src/application/fog/contentSupport.ts` | `395e8c276eb90d92f568dc65dd29530f8c185b33c9e9ef5fcdca344e646e2778` |
| `packages/core/src/application/fog/dataTypes.ts` | `bd44cbae41797b5fd20fcdbceaea763d2443e8593057ae2f046b77771247d21b` |
| `packages/core/src/application/fog/documentServices.ts` | `a2bc85cd42e7b191002d5f6e946a884419dd0fa893551f7a31e62dc28e4d75b7` |
| `packages/core/src/application/fog/memoServices.ts` | `a05352388ad763831839fe16b8d0222cbeba13545e9a3722471477e785b8235e` |
| `packages/core/src/application/fog/ports.ts` | `151eda8454f901ac8eab33d5bd00c0c27fcd93ce19efd6e5afbb97de9062988b` |
| `packages/core/src/application/fog/runtime.ts` | `bbedf8c7f96349030f6c0a73eba4c4274e99caad26578adfc7e561813275de04` |
| `packages/core/src/application/fog/searchServices.ts` | `c6d861077d40d0497a671ef2d0b9c7c1ac4512484b10414c87536893930f937a` |
| `packages/core/src/application/fog/services.ts` | `49b3c11706a19c66562cb30cc423a9169c692a40e5f0d25589ffe762c11c1803` |
| `packages/core/src/application/fog/topicServices.ts` | `d8eff69707b0233f8ac4f3c821867263c9a0b57e00efb546114a95322078d2df` |
| `packages/core/src/application/fog/trashServices.ts` | `7a2341bb1b986abaebd3fdfb53ed52982d165ffc2ee32a7c3ddf754758f392f3` |
| `packages/core/src/application/fog/types.ts` | `c75de81b8c07c74dacbbc9629bc98df16ae5dd7c259d997772d4ba21e05ca185` |
| `packages/core/src/domain/fog/ai.ts` | `ff912914ced62d97d78bd902994207e02b77d84d2f2702e0fd88342d6cf2f4c8` |
| `packages/core/src/domain/fog/content.ts` | `f8d402bb3aab8e0a77d08c956c452a51998796a7b2a5f205186bff5f78526c39` |
| `packages/core/src/domain/fog/data.ts` | `5d46967e30fb15b3e202c6232939066a15ef6a71c619fec589f3f685b21d329c` |
