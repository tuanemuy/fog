# P4a 完了候補

対象は R16〜R18。AIクライアント認可、許可操作だけのHTTP API、人間経路との隔離を実装した。独立Verifierの受け入れ前の候補である。P4bは開始していない。

## 要件対応

| ID | 実装と根拠 |
| --- | --- |
| R16 | client起点のブラウザ認可→未ログイン時login→操作一覧→許可/拒否→登録redirect。10分要求、human owner拘束、2分単回code、PKCE S256交換、30日opaque bearer。名前・接続日時・最終利用の一覧と確認付き失効。PC/mobileで実接続し、拒否state・許可・失効を確認。 |
| R17 | 読取7操作・書込8操作の明示union。最近メモ、単体、topic一覧・内容、共通検索、メモ作成/置換、topic作成/更新、文書作成/部分編集/明示rewrite、三種softDelete。版・一意一致・理由・所有者を検査。履歴/ゴミ箱/復元/完全削除/設定/exportは提供しない。 |
| R18 | mutation/revision/冪等性台帳/最終利用を同一UoWで確定。接続+key+canonical payloadへ拘束。並行・再起動後も再更新なし。成功replayは過去本文を保持せず、現在稼働中resourceの最小receiptまたはnull。失効はread/write/replayごとに検査。AI安全DTOとCookie/Bearer分離をHTTPと実DBで確認。 |

## 採用契約

Managerが採用した判断に従う。

- `FOG_AI_CLIENTS` にclient ID/name/redirectUrisを固定登録。未設定は接続可能clientなし。登録URIと完全一致、HTTPSまたはloopback HTTP、credentials/fragment/予約callback queryを拒否。動的外部登録を提供しない。
- `GET /oauth/authorize` → stored request → `/ai/authorize?request=...`。認可画面の取得で最初のhumanへ拘束。決定はcookie人間主体と同一Originを要求し、未拘束/他主体/無効要求を拒否する。信頼済みredirectの検証前に外部redirectしない。
- `POST /oauth/token` はform-urlencoded。codeとclient/redirect/PKCEを照合する。tokenは応答本文だけ、no-store。refresh tokenなし。request/code/tokenの秘密値はhashで保存する。
- `POST /api/ai` はBearerだけを受け付け、cookie併用を拒否する。人間用session getterと全mutation入口はAuthorization付き要求を拒否する。login/registerも対象。Bearerをfog_sessionへ偽装しても認証しない。
- AI responseのsource DTOからdeleted属性自体を除外する。履歴・削除済み本文/タイトル/IDはread・search・topic内容・receiptに流さない。
- 書き込みの必須 `idempotencyKey` は接続単位。同key異payloadは409。ledgerはpayload hashと最小resource参照を保存し、過去DTOを保存しない。receiptのresourceは再試行時点のactive kind/id/versionで、削除済みならnull。成功済みdeleteは人間復元後にも再削除しない。
- 文書patchは一意な完全一致、expectedVersion、理由が必須。0件・複数/重なり・本文全体を置換するpatchは拒否。全面改稿は明示 `documents.rewrite` と `confirmRewrite:true` に分ける。

クライアント契約・再実行手順・入力一覧は `docs/ai_client.md`、fixtureは `apps/web/scripts/fog-ai-client.ts`。公式一次資料は [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)。PKCE標準vectorはcore integrationで確認した。

## 自動チェック

2026-09-05 JST、証跡は `P4a-evidence/`。

- `pnpm typecheck`: root +4workspace成功。
- `pnpm lint:fix` / `pnpm format`: 成功。283 files、既存useLiteralKeysの21 infosのみ。最終修正はCLI credentialファイルchmod追加の整形。
- `pnpm test:unit`: 16 files / 109 tests成功。既存100件+HTTP境界9件。
- `pnpm test:integration`: Node 10 files / 84 tests、CF 10 files / 70 tests成功。CF終了時のworkerd WebSocket切断メッセージは失敗ではない。
- `pnpm build`: 最終UI class・CLI chmod変更後のNode production build成功。
- coreの実SQLiteは54件（P4a追加22、既存32）。認可owner、state、deny、要求/code/token期限境界、PKCE vector、不正redirect/client/PKCE、code単回/同時交換、全operation、所有者隔離、部分編集/理由/版/rewrite、AI履歴、三種softDelete、人間復元、削除source漏洩防止を確認。`P4a-core.md`。
- 同一providerと別SQLite Clientの並行、service/DB再オープン、object key orderに依存しないpayload比較、異payload、接続ごとのscope、ledger INSERT障害のcontent/revision/最終利用rollback、migration反復保持を確認。
- HTTP unitは許可operation/unknown field/owner injection、cookie-only/mixed credentials、Bearer付きhuman transport、JSON/media/body上限、不正redirectと重複query、no-store、未知error秘匿、client設定を確認。

通常unit実行に証跡用 `.goal-implement/reviews/P3-core-independent.test.ts` が混入し、rootで@libsql/client解決不可のsuite errorが出た。Manager採用のもと `vitest.config.ts` の通常探索から `.goal-implement/**` だけを除外した。製品の既存100テストは減らしていない。独立fixtureと専用configは変更しておらず、独立検証の専用実行は維持する。

## ブラウザ・HTTP実操作

agent-browser `fog-p4a`、localhost:3000、実libSQL。ローカルcallbackは127.0.0.1:3456。外部公開・外部送信なし。

検証専用human: `p4-owner-20260905@example.test` / `p4-local-password-2026`。既存P1/P2/P3の利用者データを保持し、UIから新規登録した。

### 認可

- ローカルfixtureのauthorize起動でcode verifier/stateを生成。未ログイン時にloginへ遷移し、signupを経ても元の認可要求へ戻る。操作15件・human専用操作除外・戻り先originを表示。
- 初回は拒否。callbackに元stateと `error=access_denied` が返り、接続もcredentialも作られない。`client-authorize.log`。
- logout後、次のauthorizeはloginを経て認可画面へ戻る。20:46、許可で単回codeを受け、fixtureがstate照合とPKCE交換を完了。credentialは `/tmp/fog-ai-local-token.json`、fixtureはmode0600保存し既存ファイルにもchmodを適用する。秘密値は証跡へコピーしない。
- PC1440×1000/mobile390×844の認可画面を撮影・目視確認。`P4a-consent-desktop.png` / `P4a-consent-mobile.png`。
- 無効requestの直接URLは「この認可要求は利用できません」と再接続案内を表示し、許可/拒否ボタンなし。`P4a-invalid-consent.png`。期限境界と消費済み要求はcore testsで確認。

### AI操作と人間の履歴

`P4a-api-smoke.mjs` は取得済みlocal credentialで再実行できる。20:47の19 HTTP checksを `api-results.json` に保存。

- guidanceで許可15操作と推奨動作を取得。
- AIメモ投稿・置換、topic作成・完了状態更新、出典付き文書作成、理由付きpatch、明示rewriteを実行。recent/get/topic一覧/内容/searchを取得。
- 同key同payloadは同resourceのreplayed receipt。同key異payloadは409、存在しない部分一致は422、古い版は409、別owner memo単体は404、不在sourceによる作成は404で文書を作らない。
- 文書ID `01a07164-f6f5-7054-9f68-6222079a1b4e` の人間用履歴に、AI名「ローカルAIクライアント」と3件の理由を表示。
- 人間UIで版1を選び、確認後にロールバック。20:49:01にhuman主体・「リビジョン 1 に復元」の版4を追加。APIの最新版も元本文とversion4を返す。`P4a-human-rollback.png`。
- メモID `01a07164-f6d5-77f3-a80b-fe2d3ff9cc82`、topic ID `01a07164-f6ed-73fb-84fc-bef478c2288e`。完了topicのscope検索に文書とsource memoが共にヒット。

### 隔離・冪等性・削除

- 実server functionで異Origin/空Originのconsentを403、Bearer付きlogin/registerを403、Bearerをhuman cookieへ偽装した投稿を401、Bearer+human cookieのtrash全消去を403。cookie-only AI APIも403。不正redirectは401でLocationなし。`P4a-boundary.mjs` / `boundary.json`。
- AIがメモをsoftDelete。人間の文書画面は墓標を表示し、AI document source/関連memoからは本文だけでなくメモIDも除外。create replayはreplayed:true/resource:null、getは404。`delete-replay.json`。
- 同じ書き込みを実HTTPで6件並行送信し、作成1/replay5、resource ID一意、version1。`concurrent.json`。
- owned Viteを停止・新規processへ再起動し、同じcredentialとDBでactive receiptを再試行。再更新なし、同ID/version1。削除済みmemoのcreate replayもnullでIDなし。`restart-replay.json`。
- 人間UIで削除memoを復元した後、成功済みdelete要求を再送しても再削除しない。AI getでactiveを確認。

### 接続失効

- 設定画面にclient名、接続20:46、最終利用20:56を表示。mobileは横幅390px内に収まる。`P4a-connections-mobile.png`。
- 「接続を解除」→確認→実行で一覧が空になる。以後のguidanceと成功済みcreate replayはともに401 `AI_CONNECTION_UNAUTHORIZED`。`revocation.json`。
- 検証credentialは最終状態で失効済み。独立検証ではfixtureのauthorizeから新しい接続を作る。

## 引き継ぎ

P4aの未完了機能・既知のP4a機能不具合なし。独立検証前の実装側確認であり、独立Verifierの代替ではない。Manager台帳と全体goalは変更していない。

最終human状態は接続なし、ゴミ箱空、topic1件（完了済み）、文書1件（human rollback後version4）、memo2件（AI編集・復元済みmemoと並行試験memo）。再実行fixtureと対象IDsは上記に記録。P4bのGoogle SSO・メール復旧は未着手。

devの起動設定:

```bash
DATABASE_URL=file:./data/app.db APP_URL=http://localhost:3000 \
FOG_AI_CLIENTS='[{"id":"fog-local-client","name":"ローカルAIクライアント","redirectUris":["http://127.0.0.1:3456/callback"]}]' pnpm dev
```

ブラウザはclose済み。local callback listenerは応答後に終了済み。

## 最終対象記録

日時: 2026-09-05T21:02:59.403539+09:00。HEAD: `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。dev PID `99712` / exec session `28369` / localhost:3000、登録local client設定を含む最終コードで再起動済み。

未コミットP1〜P3を含む全変更 142 パス（削除含む）。`.goal-implement/` は実装hashから除外。JSONは `P4a-target-hashes.json`。この記録以降、コード・DB・ブラウザの全書込みを停止する。

| ファイル | SHA-256 |
| --- | --- |
| `apps/web/.env.example` | `410590272dd16baa546d6b8961a3037d99c4eb4532d0e4581397ec73b88c2761` |
| `apps/web/app/components/fog/AiConnectionsPanel.tsx` | `b3b6eee67113be7dc6aede0101d48eda55cf8d4dc3910fc5c030ae443f949932` |
| `apps/web/app/components/fog/AiConsentContent.tsx` | `b3484108453186a63a51453a5d61cef376200d6d260e28234008d91020db8e35` |
| `apps/web/app/components/fog/AiConsentPanel.tsx` | `f36db49f959db4d6cc364689b4f45933e2b74f6be89c043e0cd93a18f2a99a89` |
| `apps/web/app/components/fog/AuthForm.tsx` | `41369ac8f2ed85c653dbe7e1ba5d837203b39df0bef8da8096f4bd0abfee5f59` |
| `apps/web/app/components/fog/Brand.tsx` | `90612a20a84b0207dd22524cd5133272ab6d8c75e2650a9c1bd246e03d1c4895` |
| `apps/web/app/components/fog/ConfirmDialog.tsx` | `6bd0674000da11f6b7d59e6cfe408f900f87788fcf0ff162e7b8e3a282fad7f1` |
| `apps/web/app/components/fog/ContentDeletion.tsx` | `acc29ff6a15168557fe1298a59fa6a70878b248e2452389d7d53e47897c6c247` |
| `apps/web/app/components/fog/DocumentContent.tsx` | `b64380c46ba1b99e6ae128aefe3334757bcf081799b0548920bb96ce5d908331` |
| `apps/web/app/components/fog/DocumentEditor.tsx` | `56f933b0b33dc6e34a3429f24d213349f956fdb7da9f8b32a01f33b451c7d939` |
| `apps/web/app/components/fog/DocumentHistoryContent.tsx` | `38879765f54c332942b728d77834eb728a8f37b136c6abff2f65ba56cf48edd0` |
| `apps/web/app/components/fog/DocumentSourcePicker.tsx` | `9e72c2f512e633e864ab05ddc647590591c0a2e45c946c369615ee76d74cc343` |
| `apps/web/app/components/fog/DocumentView.tsx` | `ce150598aa255f92deb6687ac44bf4492b61f57bcc023846dc792ff349d47bd0` |
| `apps/web/app/components/fog/FogShell.tsx` | `5401fc5f5eb59a1fa9c240bb040f513149a2385a863578ee3f8ca080d0041db9` |
| `apps/web/app/components/fog/Markdown.test.tsx` | `8735be5d2a6ecbf596cf69f5dfc6e8d173c7c9a3cb29d4c4387ad88e8c46e345` |
| `apps/web/app/components/fog/Markdown.tsx` | `1e70533ceb592e6471019a7f5d4ebc6fc2473fbcf556dd32fb1e6550f73569c0` |
| `apps/web/app/components/fog/MemoHistoryClient.tsx` | `da94d8f87d7b2796853322a5a16c99eab5e38caace698216b5f7a3ca678d5106` |
| `apps/web/app/components/fog/MemoHistoryContent.tsx` | `7a68d20db68fbed050b9fe9c2745c61e8ea86345919e4d800602143de178b6ec` |
| `apps/web/app/components/fog/MemoItem.tsx` | `c1165c507fe14ede153461cade2e18c3ed899756fcf3e9c1e7530cb8f5d05a31` |
| `apps/web/app/components/fog/RevisionHistory.tsx` | `796e47e31ba399ff5010b846bd336e1b4b30569abfcf7f267ef406c3ce5b8c34` |
| `apps/web/app/components/fog/SearchBoard.tsx` | `81d2458478ae947c7cf0086550a25002ee87ef9af2ad4e4701e89139cea9a105` |
| `apps/web/app/components/fog/SearchContent.tsx` | `0e800d003b3e2c06ac6b7cdd8ba710723ebff699ae8b072b15168351ad1c5710` |
| `apps/web/app/components/fog/SettingsContent.tsx` | `9b6d59ecdb8825af58f10ce6d4789bde6d11c458bd51c681a4b6468adf455951` |
| `apps/web/app/components/fog/SettingsPanel.tsx` | `5cff8cb844e7db636cc8efb6902cb024b61c41512b642d174e6ce080bf1c122e` |
| `apps/web/app/components/fog/TimelineBoard.tsx` | `6b40e4934615880f5b4c721b3fad643b9f6f9929b3555ce0a0f01500fbed6eb5` |
| `apps/web/app/components/fog/TimelineContent.tsx` | `1379592943c62baffe22b656a48caf36d4571ea8c990d74407b6c802b7882c23` |
| `apps/web/app/components/fog/TimelineFilters.tsx` | `2cea6a4303991c9fff78f4d098c1a3920e782b4c395c4788493765674e95c44d` |
| `apps/web/app/components/fog/TimelineSkeleton.tsx` | `f43e1c7a0c3f25cb0c947232c469b94abb2135384c3916836d64850309e7f1de` |
| `apps/web/app/components/fog/TopicContent.tsx` | `77732d64af2dd81322cde331585d1441ddf8aafced7f62700b82104cbf8f9b12` |
| `apps/web/app/components/fog/TopicDetail.tsx` | `0c495d37e141a1b6c8d159f18432fb96ae5bc88f4cb550ff71b8c62f6a432794` |
| `apps/web/app/components/fog/TopicsBoard.tsx` | `954fde9a6c8c77029365a3021d22d8c4b43edd06f0866d76e3f2ca18484d8cf5` |
| `apps/web/app/components/fog/TopicsContent.tsx` | `ba89fc23244f70fafcc89bd07c5eed32c35763bdbc389758cd9d4d4977f42547` |
| `apps/web/app/components/fog/TrashBoard.tsx` | `635bb1735505f0711249de620d99c1c6811829b4989d125d73a14b69be5d6fb7` |
| `apps/web/app/components/fog/TrashContent.tsx` | `067f04f99a18a317f677ed5a1d6f2ed25f2a07e12f8a336a55494b05547e041a` |
| `apps/web/app/components/todo/CreateTodoForm/action.ts` | `deleted` |
| `apps/web/app/components/todo/CreateTodoForm/index.tsx` | `deleted` |
| `apps/web/app/components/todo/TodoBoard/action.ts` | `deleted` |
| `apps/web/app/components/todo/TodoBoard/index.tsx` | `deleted` |
| `apps/web/app/components/todo/TodoItem/action.ts` | `deleted` |
| `apps/web/app/components/todo/TodoItem/index.tsx` | `deleted` |
| `apps/web/app/components/todo/TodoList/action.ts` | `deleted` |
| `apps/web/app/components/todo/TodoList/index.tsx` | `deleted` |
| `apps/web/app/components/todo/TodoListSkeleton/index.tsx` | `deleted` |
| `apps/web/app/components/todo/TodoShell/index.tsx` | `deleted` |
| `apps/web/app/components/todo/schema.ts` | `deleted` |
| `apps/web/app/presentation/appServerErrorAdapter.ts` | `a490fed43bcec46643750df3d9482c9a213f00e1af354746efeae8232fb73f1c` |
| `apps/web/app/presentation/errorResponse.ts` | `422c95673c3f865602c99c1c9adb7c79e8e21b77c09e4788329757ad711200ba` |
| `apps/web/app/presentation/errorResponseMiddleware.ts` | `567d043a8e7ead39b528e14a88e6ba7b2d9a893691deff96930a0126e9d40a72` |
| `apps/web/app/presentation/fogActions.tsx` | `39521681ff971814459584bebad93a17b861223b01d1fca102548083978e40b6` |
| `apps/web/app/presentation/fogAiActions.tsx` | `58a26407eca609cb010619a2d6d1f76082e7c968bae97c2ce26c201e2a8bf01f` |
| `apps/web/app/presentation/fogAiConfig.ts` | `7176aad6b2e58ec34872ca6da33b0c80b3f0fe164e5b49cc6b51bdec71afabe8` |
| `apps/web/app/presentation/fogAiHttp.test.ts` | `a35606fc461dac33cbebd186d35a1a60820ef70e3cefbaaf8d5f39ac11f19c26` |
| `apps/web/app/presentation/fogAiHttp.ts` | `ba6db4c2169022a235373bcb9f6f53cf32f6723ff7d6d1e2eb10233872f31016` |
| `apps/web/app/presentation/fogAiSchema.ts` | `a0e36b6eb18f21916b4cd41be31cfa2126bb2a794f3c5564ebc6fc260c1823ee` |
| `apps/web/app/presentation/fogAuth.ts` | `1aa556d009493685d13926ae59916a15496a81f2f7c64709cede3c53c7e4b607` |
| `apps/web/app/presentation/fogDataActions.tsx` | `c8203d98b37df27aa4e40e3b6986cec2fadb964eb9be21111ed7b6f0dd4b1c2c` |
| `apps/web/app/presentation/fogDataSchema.ts` | `d39253c820784a92ac0191f48e6816f393d513daa0581bc5ca63a26e41c86496` |
| `apps/web/app/presentation/fogDocumentActions.tsx` | `e9edd674f8a503c62d4b6c9f21660b5d9fdc57cce5aded2999b18a34f7f104ff` |
| `apps/web/app/presentation/fogErrorTransport.test.ts` | `08ed8e3ba3fb16db6c0f58bfea33337cad38e09e983fac1dec5c61a56a69d2e9` |
| `apps/web/app/presentation/fogMemoActions.tsx` | `a28c9271277ac9d9ed055b59ecdbcdb31add3e2441e390ad4ecae4f567c208f9` |
| `apps/web/app/presentation/fogSecurity.test.ts` | `0a286c8e3017f284365a1d5fc782c7309fcbd4791e72300e813d0c2302c0fb89` |
| `apps/web/app/presentation/fogSecurity.ts` | `3936936e493242ed73742a928d1b38627ab4f0767181da6a2c7ac803404664fe` |
| `apps/web/app/presentation/fogSsrStreaming.test.ts` | `5249c2fb7e8d563ae64db71da35a3682fe8e10017708eb5b37ed1cf888ae6c9f` |
| `apps/web/app/presentation/fogTimelineSchema.test.ts` | `4493397387ee09c178b8590ffb26a2fa5ba3b1dbb36a5c658b3542b75ee65b4c` |
| `apps/web/app/presentation/fogTimelineSchema.ts` | `eb19d5cfd94ca0d822488178021416095b46eb7196c73a74024d61e318183ee9` |
| `apps/web/app/routeTree.gen.ts` | `2b4cf96bb870015a3378edd2a2cb72974be8fa5d69e380e019010777b89fa771` |
| `apps/web/app/routes/__root.tsx` | `93500488ea1cdfe45c9a324c0f7fe70f6a6636f31c8eecc23c7edc7146b6a5ba` |
| `apps/web/app/routes/ai.authorize.tsx` | `7512a9fe0a55e6748ac9e3b083948941606f97f5a3e7d652e27cdef01d1ecb05` |
| `apps/web/app/routes/documents.$documentId.tsx` | `744a95119b3d98cce885e62adfa469c5769fa58b4aa94a083f0f4b326fec1e71` |
| `apps/web/app/routes/documents.$documentId_.edit.tsx` | `1e239986f5f9d9170ed1f322c64877aae33e7d8e62bb8d514be3bf92d736c1bd` |
| `apps/web/app/routes/documents.$documentId_.history.tsx` | `cbc11349caf4e199ad9797382c533d0f513401838744dc6fd3770ef43197786b` |
| `apps/web/app/routes/index.tsx` | `f9ac6e842114312f2b1abbdd1ddd6e18c62ed1ba88342950f70eea6da847caef` |
| `apps/web/app/routes/login.tsx` | `bc8694992ab70fa2c0238012451fee5e0ddc488b294c5cf9ef42bc3797e2fe76` |
| `apps/web/app/routes/memos.$memoId.history.tsx` | `a9612d84bef5defa657fbd95a054d1732c44c30c6a62778abc4b748615ca9170` |
| `apps/web/app/routes/search.tsx` | `ed73f9670c7123ec74c0c8b3dff1ea4fbce098b3d2ffabefcb6c132176099e6c` |
| `apps/web/app/routes/settings.tsx` | `b41ba74f5caf80ef3858f3f3efbbd0fbf29c8fd6b08d46e3c2ec7e9caa3e8b77` |
| `apps/web/app/routes/signup.tsx` | `46605ecff35d109d8a24f45732e7219979f9bfcfc1f28394eb1037db71d20350` |
| `apps/web/app/routes/timeline.tsx` | `5560528dcf0c7ae2d0f3c64aa015d818e714df86e489de4919e99a1b99599e22` |
| `apps/web/app/routes/todo/-action.tsx` | `deleted` |
| `apps/web/app/routes/todo/about.tsx` | `deleted` |
| `apps/web/app/routes/todo/index.tsx` | `deleted` |
| `apps/web/app/routes/todo/route.tsx` | `deleted` |
| `apps/web/app/routes/topics.$topicId.tsx` | `c1a2eb5463823b5dd4af9ff3b08841c392faca39ce7b947756488c5e18d26581` |
| `apps/web/app/routes/topics.$topicId_.new.tsx` | `61f01e5125a35d01481aac91d60112d55588e878306664d0400712768a5e9628` |
| `apps/web/app/routes/topics.index.tsx` | `6bfc17c6dee2282745576b2d0370166184eb45152c31877b2b1052ce203c90b5` |
| `apps/web/app/routes/trash.tsx` | `30d883b37ebac370e3d3a3ee3505fe95592b50cb10cd0fdb65f1eee2a1027cf7` |
| `apps/web/app/server.node.ts` | `f730308f0a46be54132c663cd54825a681a908eb3b0a198370ed0c9666d44b4e` |
| `apps/web/app/styles/fog-content.css` | `76dcb6c53ff11199aad1c8aab491e9a86800e812b73a782fb5205b81ca17c85a` |
| `apps/web/app/styles/fog-data.css` | `a38981ab2b68fd68ac5365a291478305d6f9d6ee1d0c1b946a006e493cf264a2` |
| `apps/web/app/styles/fog.css` | `6f8350dc2d4d6c0d15cd73a02648501b2faf6c09b706f13e6b709731eb08c90c` |
| `apps/web/app/styles/index.css` | `5eca64ff37604f2205d2b66a4bec450a4b75b09e0ba70b7bbb4d8f2bdfecb54f` |
| `apps/web/app/styles/tokens.css` | `4c2bca2d1d30df362b0d3adbdf2d27b5d1fda3c59289a5140c5cf6cb4d113813` |
| `apps/web/app/worker/node/fogRetentionRunner.test.ts` | `71ba7fdb16153e4dff2f62392e18b9a39c11c15a1b62e4618eb2ac7db6a1435f` |
| `apps/web/app/worker/node/fogRetentionRunner.ts` | `62a8d513b339b370d44b4c2ee1d3d218e25429775762659e4c6abca184de8a1f` |
| `apps/web/package.json` | `7a1bfb0a9a62304e8e0640896757013ed1d99f6ce69a00724cba040c6cbece55` |
| `apps/web/public/favicon.svg` | `33b6f323029c9f5f84c9a42424f12496b0deb2ab7d873c46b21c444f7152989c` |
| `apps/web/public/fog-logo.svg` | `7f0293522c7c30502e1f7900688384a9435f0084b22af3e156c7fe9967b0227f` |
| `apps/web/scripts/fog-ai-client.ts` | `6a256f454a977acc07f5ee717a2d1c95b1783286163f528fecbb784d67ae5502` |
| `apps/web/scripts/migrate.node.ts` | `b6a5dc911311484c54926a18a35f2fdf9d16849c9ea65e1739ec46dbf2c3566f` |
| `docs/ai_client.md` | `7e3a061e43cceb5ec8f007f9c06002f103f9d98a12bfc69f3a47500e2a7255b1` |
| `docs/fog_operations.md` | `cf42d65a8dcddc0bf3603ad4c84489d05a382fb07fc4f6389ea279223a821421` |
| `docs/ssr_streaming_patch.md` | `ae9fdf4fab548c4c11dd9066f665c4809b8edf4813dc5b2191adaeb29e2d743d` |
| `packages/core/src/adapters/d1/migrations/0000_dazzling_demogoblin.sql` | `e3585b4a0931eadb69ae372e062286bb4d1614ceffa4c4f1f041500869f4d42c` |
| `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json` | `9fec7053bd805b4ca421224380174edbde058d64ee0c9a0ae930635db96ece86` |
| `packages/core/src/adapters/d1/migrations/meta/_journal.json` | `7006135caaf7d0a8f9af6d93868a61358531a5caf7e85fda76e3b44392d54f47` |
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
| `packages/core/src/adapters/libsql/migrations/0000_smiling_kree.sql` | `e3585b4a0931eadb69ae372e062286bb4d1614ceffa4c4f1f041500869f4d42c` |
| `packages/core/src/adapters/libsql/migrations/meta/0000_snapshot.json` | `c077a39ac960030e215407532379753bbbe227213846a1283b40cef271bf7ee3` |
| `packages/core/src/adapters/libsql/migrations/meta/_journal.json` | `63d460b9fca7ba3e7f5089af1f6af4853a07b2bf5826ae64fa0ef11dd469420c` |
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
| `packages/core/src/config.ts` | `0aeb748950d86b10fc211b1cf63c62b4fbd3143e71a680e52036e18fec0c9b23` |
| `packages/core/src/domain/fog/ai.ts` | `ff912914ced62d97d78bd902994207e02b77d84d2f2702e0fd88342d6cf2f4c8` |
| `packages/core/src/domain/fog/content.ts` | `f8d402bb3aab8e0a77d08c956c452a51998796a7b2a5f205186bff5f78526c39` |
| `packages/core/src/domain/fog/data.ts` | `5d46967e30fb15b3e202c6232939066a15ef6a71c619fec589f3f685b21d329c` |
| `patches/@tanstack__router-core@1.169.2.patch` | `c05f4c5732d24cb5648c2498e0254c377b31c0c0f854302fac2c88c5abdfb59d` |
| `pnpm-lock.yaml` | `a291a807c8bcf760234b7303abb672a2a11c536f313362e0fae621d046915634` |
| `pnpm-workspace.yaml` | `91a0efd231c962cf5730e0842bf255386ba4f16e4e7886cd5985418ec38afa42` |
| `vitest.config.integration.node.ts` | `ac92ea2abf24cf1bd2d1f8b605c22966f0c29522ae49de71e5fb6e6bef0cbb4c` |
| `vitest.config.ts` | `72b703e490ec77bcf5eb561728131eff4752729a329a270ed218c8a12dba8d0a` |
