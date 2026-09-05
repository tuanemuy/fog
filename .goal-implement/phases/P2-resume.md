# P2 完了候補: コンテンツ・履歴・出典

## 状態と対象

2026-09-05T19:29:38+09:00。対象 R03〜R09、Manager review待ち。基準commit `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。差分は未コミット、既存変更を保持。旧[P2報告](P2.md)と[再開照合](../reviews/resume.md)を保持する。独立Verifierによる受け入れは未実施。

## 修正

- B-P2-01: router-core `1.169.2` のSSR fast pathが未注入script queueを無視する。`<Scripts />`描画後、HTML transform開始前にdeferredのserializationが完了すると、resolverだけを送ってFlight payloadとsettlementを破棄する。最小回帰テストで同じHTMLを再現し、修正前FAIL・修正後PASSを確認した。`Serialization error`が原因ではない。
- バージョン固定とpnpm patchで、未注入queueのある応答を通常の注入経路へ通す。終了前に同期flushする。元のRSC/Deferred/Suspenseによるstreamingを保持する。[パッチ説明と公式出典](../../docs/ssr_streaming_patch.md)。
- B-P2-02: 追加読込したメモの保存結果を一覧ownerへ戻し、現在keywordに合うメモだけを表示する。65件取得後の最古メモを不一致へ編集すると64件になり、対象行が消えることをブラウザとDBで確認した。
- メモ・文書のrollback失敗時も`router.invalidate()`で最新の履歴と版を取得する。履歴を開いた後の別画面編集による競合から、その画面のまま再試行できる。

## 要件とブラウザ根拠

localhost:3000、Chromium、2026-09-05 19:10〜19:27 JST、`fog-p2-resume` / `fog-p2-final`。AはP1のテストアカウント。新規の実ユーザーデータを扱わない。

| ID | 操作と結果 |
| --- | --- |
| R03 | 直接reload後に本文を入力し投稿。offline失敗時は下書き保持・error表示・楽観行0件。onlineで同じ投稿を再試行して入力が空になり、reload後も「P2 再読込後にも投稿できる」を表示 |
| R04 | keyword「P2 過去メモ」で初期30件→60件→65件。DOM ID unique=65、番号65から01まで順に各1件。最古01をkeyword不一致へ編集して64件・対象IDなし、DBは新本文/版2。最古ID直指定で先頭1件に表示。日付2026-08-15は近傍の8/7へ、日付欄を8/3へ設定して「表示」を押すと8/3の最新メモへ移動 |
| R05 | メモ直接historyのボタンすべてReact propsあり、二点diffが追加/削除を表示。版1を復元して版3として追加。二画面編集で先行版4を保ち、警告後に自分の内容を版5へ保存。履歴画面を開いた後に別画面で版6へ編集し、古い版でrollbackすると競合エラーと最新6版を表示。再試行は版7として復元し、履歴7件をDB確認 |
| R06 | 直接topicsから説明なしトピック作成、空名時disabled、reload後保持。既存トピックの名前/説明を編集して保持。完了にすると一覧下部の折り畳み「完了済み(1)」に移り、詳細から解除してreload後「完了にする」を表示 |
| R07 | トピックからタイトル/Markdown/理由/出典付き文書を作成。reload後に見出し・箇条書き・コードブロックを整形表示。無変更保存で版4のまま。所属必須/不正参照拒否はP2 integrationの実DB根拠を維持 |
| R08 | UI検索「P2 出典メモ」でcheckboxを選び文書保存。文書の出典リンクから対象メモへ、メモの逆リンクから文書へ遷移。元メモ編集後に文書へ戻ると最新本文を表示。トピック詳細は文書1件・関連メモ1件と最新本文を表示 |
| R09 | 文書二画面編集で先行版2を保持し、警告/最新内容/確認checkboxの後に自分の版3を保存。履歴は主体/日時/入力理由と省略時「手動編集」を表示。版1対3のtitle/body差分、版1復元→版4、再表示を確認 |

日付ネイティブpopupの月ボタン操作でagent-browserのChromeが停止したため、そのsessionだけを終了した。日付入力の検証はnative value setterとinput/changeイベントで日付欄を設定し、画面の「表示」を押す方法で実施した。ネイティブカレンダー内のクリック操作は未確認。日付欄、URL、近傍検索、遷移結果は確認済み。

## 表示確認

PC 1280×900とスマホ390×844で確認。スマホのdocumentWidth=innerWidth=390。モバイルメニューは下部dialogで開閉し、タイムラインへ遷移する。画像を開き、文書本文・出典、タイムライン、bottom sheet、共通シート・pill操作色・横溢れなしを確認した。

- [PC timeline](P2-resume-desktop.png)
- [スマホ timeline](P2-resume-mobile-timeline.png)
- [スマホ document](P2-resume-mobile-document.png)
- [スマホ menu](P2-resume-mobile-menu.png)
- [topic detail](P2-resume-topic.png)
- [document diff](P2-resume-document-diff.png)

## 最終コードのchecks

| 日時 JST | コマンド | 結果 |
| --- | --- | --- |
| 19:08 | SSR最小回帰test、unpatched | FAIL。resolverのみでresolved content/e()欠落を再現 |
| 19:09/19:22 | 同test、patched | PASS。早期/遅延settlementの2ケース |
| 19:23 | `pnpm typecheck && pnpm lint:fix && pnpm format` | 成功。既存lint info21件のみ、errorなし |
| 19:24 | `pnpm test:unit` | 14 files / 98 tests成功 |
| 19:24 | `pnpm test:integration:node` | 8 files / 46 tests成功。schema差分なし |
| 19:24 | `pnpm build` | Node client/RSC/SSR production bundle成功 |
| 19:26 | 独立tempディレクトリに同version/patchを`pnpm install --offline --ignore-scripts` | 5 packages fresh install成功。source/ESM/CJSの対象SHA-256がworkspaceのinstalled packageと一致 |

型check初回の回帰test側ES lib/Node Stream型の不一致は修正済み。上表は修正後のコード。既存のP2 integrationは不正owner/所属/出典参照の原子的拒否、nochange/空本文/一行reason、版競合、非破壊復元、AI履歴拒否を確認する。

## 実行と検証引継ぎ

開発serverは維持。exec session `6362`、Vite PID `70559`、localhost:3000。起動は `DATABASE_URL=file:./data/app.db APP_URL=http://localhost:3000 pnpm dev`。DBは`apps/web/data/app.db`、既存.envを保持。SIGINT初回はserver bootのshutdown listenerのみが処理しプロセスが残る場合があるため、port解放を確認してから再起動する。

ブラウザ `fog-p2-final` はclose済み。`fog-p2-resume` はネイティブpopup操作で停止した自身のdaemon/Chromeだけを終了し、残sessionも19:29にclose済み。Implementerは本報告後にコード書込み・ブラウザ/サーバー操作を止め、独立Verifierへ渡す。

主な検証データ:

- メモ `01a070f4-c5c7-7222-ab66-2d7bfda3ad54`: 現在版7、版1本文へ復元、全7版を保持。
- 最古seedメモ `01a070f4-776e-715c-a946-205e60d07268`: 版2、本文「P2 別の内容 01 keyword不一致へ編集」。seedのkeyword結果は現在64件。
- トピック `01a070fc-74e0-735c-b370-13d0ea0d3a7e`: 「P2 fogの体験設計（再開）」、説明あり、進行中。
- 文書 `01a0710f-e4fb-749e-b3d5-2432dfe7df3a`: 「P2 復元できる文書」、現在版4、版1へ復元、上記メモを出典に持つ。
- 「P2 説明を省略したトピック」: 直接SSRの作成確認用。

P3〜P5は未着手。削除、横断検索、AI API、外部認証/メール、クラウド保存の実環境はP2完了範囲に含めない。

## 対象SHA-256

P1/P2の全実装差分を含む。進捗記録とブラウザ画像は除外。以下を最終検証対象とする。

```text
41369ac8f2ed85c653dbe7e1ba5d837203b39df0bef8da8096f4bd0abfee5f59  apps/web/app/components/fog/AuthForm.tsx
90612a20a84b0207dd22524cd5133272ab6d8c75e2650a9c1bd246e03d1c4895  apps/web/app/components/fog/Brand.tsx
b64380c46ba1b99e6ae128aefe3334757bcf081799b0548920bb96ce5d908331  apps/web/app/components/fog/DocumentContent.tsx
56f933b0b33dc6e34a3429f24d213349f956fdb7da9f8b32a01f33b451c7d939  apps/web/app/components/fog/DocumentEditor.tsx
38879765f54c332942b728d77834eb728a8f37b136c6abff2f65ba56cf48edd0  apps/web/app/components/fog/DocumentHistoryContent.tsx
9e72c2f512e633e864ab05ddc647590591c0a2e45c946c369615ee76d74cc343  apps/web/app/components/fog/DocumentSourcePicker.tsx
ac9646e5c89a121495d7eaaec5c9f924a4048644e1f0fa8f0f72ad15a8b46b90  apps/web/app/components/fog/DocumentView.tsx
eb614bd18ec4e296fa507b0164426ca71e13ef57465473e534310b69697d5f65  apps/web/app/components/fog/FogShell.tsx
8735be5d2a6ecbf596cf69f5dfc6e8d173c7c9a3cb29d4c4387ad88e8c46e345  apps/web/app/components/fog/Markdown.test.tsx
1e70533ceb592e6471019a7f5d4ebc6fc2473fbcf556dd32fb1e6550f73569c0  apps/web/app/components/fog/Markdown.tsx
da94d8f87d7b2796853322a5a16c99eab5e38caace698216b5f7a3ca678d5106  apps/web/app/components/fog/MemoHistoryClient.tsx
7a68d20db68fbed050b9fe9c2745c61e8ea86345919e4d800602143de178b6ec  apps/web/app/components/fog/MemoHistoryContent.tsx
103247b85e02f1c6cdac071efd06e2aef040d34d9d57201e759643194484445b  apps/web/app/components/fog/MemoItem.tsx
796e47e31ba399ff5010b846bd336e1b4b30569abfcf7f267ef406c3ce5b8c34  apps/web/app/components/fog/RevisionHistory.tsx
7b5469f250ff6c4ff48c3bdc47fb3e56dcfe2645fb2ea53c8e812a3b5ffe0124  apps/web/app/components/fog/TimelineBoard.tsx
1379592943c62baffe22b656a48caf36d4571ea8c990d74407b6c802b7882c23  apps/web/app/components/fog/TimelineContent.tsx
2cea6a4303991c9fff78f4d098c1a3920e782b4c395c4788493765674e95c44d  apps/web/app/components/fog/TimelineFilters.tsx
f43e1c7a0c3f25cb0c947232c469b94abb2135384c3916836d64850309e7f1de  apps/web/app/components/fog/TimelineSkeleton.tsx
77732d64af2dd81322cde331585d1441ddf8aafced7f62700b82104cbf8f9b12  apps/web/app/components/fog/TopicContent.tsx
191a0706d865ad9bcb2538a1d1bae3ab901bc7ae55e30821064a17bc7e489208  apps/web/app/components/fog/TopicDetail.tsx
954fde9a6c8c77029365a3021d22d8c4b43edd06f0866d76e3f2ca18484d8cf5  apps/web/app/components/fog/TopicsBoard.tsx
ba89fc23244f70fafcc89bd07c5eed32c35763bdbc389758cd9d4d4977f42547  apps/web/app/components/fog/TopicsContent.tsx
deleted  apps/web/app/components/todo/CreateTodoForm/action.ts
deleted  apps/web/app/components/todo/CreateTodoForm/index.tsx
deleted  apps/web/app/components/todo/TodoBoard/action.ts
deleted  apps/web/app/components/todo/TodoBoard/index.tsx
deleted  apps/web/app/components/todo/TodoItem/action.ts
deleted  apps/web/app/components/todo/TodoItem/index.tsx
deleted  apps/web/app/components/todo/TodoList/action.ts
deleted  apps/web/app/components/todo/TodoList/index.tsx
deleted  apps/web/app/components/todo/TodoListSkeleton/index.tsx
deleted  apps/web/app/components/todo/TodoShell/index.tsx
deleted  apps/web/app/components/todo/schema.ts
a490fed43bcec46643750df3d9482c9a213f00e1af354746efeae8232fb73f1c  apps/web/app/presentation/appServerErrorAdapter.ts
422c95673c3f865602c99c1c9adb7c79e8e21b77c09e4788329757ad711200ba  apps/web/app/presentation/errorResponse.ts
567d043a8e7ead39b528e14a88e6ba7b2d9a893691deff96930a0126e9d40a72  apps/web/app/presentation/errorResponseMiddleware.ts
39521681ff971814459584bebad93a17b861223b01d1fca102548083978e40b6  apps/web/app/presentation/fogActions.tsx
a2afeb7b1a08a39cbb1559d8fe4c44244770aab4e51f4400faa392a10a9defdb  apps/web/app/presentation/fogAuth.ts
e9edd674f8a503c62d4b6c9f21660b5d9fdc57cce5aded2999b18a34f7f104ff  apps/web/app/presentation/fogDocumentActions.tsx
08ed8e3ba3fb16db6c0f58bfea33337cad38e09e983fac1dec5c61a56a69d2e9  apps/web/app/presentation/fogErrorTransport.test.ts
a28c9271277ac9d9ed055b59ecdbcdb31add3e2441e390ad4ecae4f567c208f9  apps/web/app/presentation/fogMemoActions.tsx
0a286c8e3017f284365a1d5fc782c7309fcbd4791e72300e813d0c2302c0fb89  apps/web/app/presentation/fogSecurity.test.ts
d4e026ac646fa88339177207b011c1a8e384d63f0a215d44744103aa101b6734  apps/web/app/presentation/fogSecurity.ts
5249c2fb7e8d563ae64db71da35a3682fe8e10017708eb5b37ed1cf888ae6c9f  apps/web/app/presentation/fogSsrStreaming.test.ts
4493397387ee09c178b8590ffb26a2fa5ba3b1dbb36a5c658b3542b75ee65b4c  apps/web/app/presentation/fogTimelineSchema.test.ts
eb19d5cfd94ca0d822488178021416095b46eb7196c73a74024d61e318183ee9  apps/web/app/presentation/fogTimelineSchema.ts
a9634952f4c7cc72edca7244cd2a976b2701e53779f8f81bcdda2aaccfc6432f  apps/web/app/routeTree.gen.ts
fe6e5f3d8cb3b6f9724fb9c8ad19bc7b6869f1608a194a61939c953ca572fb0d  apps/web/app/routes/__root.tsx
744a95119b3d98cce885e62adfa469c5769fa58b4aa94a083f0f4b326fec1e71  apps/web/app/routes/documents.$documentId.tsx
1e239986f5f9d9170ed1f322c64877aae33e7d8e62bb8d514be3bf92d736c1bd  apps/web/app/routes/documents.$documentId_.edit.tsx
cbc11349caf4e199ad9797382c533d0f513401838744dc6fd3770ef43197786b  apps/web/app/routes/documents.$documentId_.history.tsx
f9ac6e842114312f2b1abbdd1ddd6e18c62ed1ba88342950f70eea6da847caef  apps/web/app/routes/index.tsx
bc8694992ab70fa2c0238012451fee5e0ddc488b294c5cf9ef42bc3797e2fe76  apps/web/app/routes/login.tsx
a9612d84bef5defa657fbd95a054d1732c44c30c6a62778abc4b748615ca9170  apps/web/app/routes/memos.$memoId.history.tsx
46605ecff35d109d8a24f45732e7219979f9bfcfc1f28394eb1037db71d20350  apps/web/app/routes/signup.tsx
5560528dcf0c7ae2d0f3c64aa015d818e714df86e489de4919e99a1b99599e22  apps/web/app/routes/timeline.tsx
deleted  apps/web/app/routes/todo/-action.tsx
deleted  apps/web/app/routes/todo/about.tsx
deleted  apps/web/app/routes/todo/index.tsx
deleted  apps/web/app/routes/todo/route.tsx
c1a2eb5463823b5dd4af9ff3b08841c392faca39ce7b947756488c5e18d26581  apps/web/app/routes/topics.$topicId.tsx
61f01e5125a35d01481aac91d60112d55588e878306664d0400712768a5e9628  apps/web/app/routes/topics.$topicId_.new.tsx
6bfc17c6dee2282745576b2d0370166184eb45152c31877b2b1052ce203c90b5  apps/web/app/routes/topics.index.tsx
7f9b4e3dc6743905724e5eb7e92006eee7d1b803a7358ae4499fab9c68c62608  apps/web/app/server.node.ts
76dcb6c53ff11199aad1c8aab491e9a86800e812b73a782fb5205b81ca17c85a  apps/web/app/styles/fog-content.css
6f8350dc2d4d6c0d15cd73a02648501b2faf6c09b706f13e6b709731eb08c90c  apps/web/app/styles/fog.css
33e691b8c2d30b406b07afa2631d43f1701459b2ef65ca569c3a42749836eec0  apps/web/app/styles/index.css
4c2bca2d1d30df362b0d3adbdf2d27b5d1fda3c59289a5140c5cf6cb4d113813  apps/web/app/styles/tokens.css
7a1bfb0a9a62304e8e0640896757013ed1d99f6ce69a00724cba040c6cbece55  apps/web/package.json
33b6f323029c9f5f84c9a42424f12496b0deb2ab7d873c46b21c444f7152989c  apps/web/public/favicon.svg
7f0293522c7c30502e1f7900688384a9435f0084b22af3e156c7fe9967b0227f  apps/web/public/fog-logo.svg
b6a5dc911311484c54926a18a35f2fdf9d16849c9ea65e1739ec46dbf2c3566f  apps/web/scripts/migrate.node.ts
ae9fdf4fab548c4c11dd9066f665c4809b8edf4813dc5b2191adaeb29e2d743d  docs/ssr_streaming_patch.md
8bcc832ce9ef8237dc4245d97ea3e3d71c21e204af3f5adcd34e67603c8bb3b0  packages/core/src/adapters/fog/__tests__/content.integration.test.ts
7d0596b459f471e134c91267dede92d29fb9e9209c5d43dc7fd8950b7ac4a66c  packages/core/src/adapters/fog/__tests__/services.integration.test.ts
e5373f477573dfef39a0f1afb6913c61ae5a3cd1c63b532cbf2336029db330f4  packages/core/src/adapters/fog/contentRepositories.ts
f4c59d108cdaa8021135581b524d8978e83950832ed074963233d710550b39ff  packages/core/src/adapters/fog/crypto.ts
a25b7d0046ae6330f112ed25ee842f0cc4d1be14fe74e418467aaaa58b36fa03  packages/core/src/adapters/fog/schema.ts
68c8b4fc0ef46f5b63b25a8980efb5d7e1858c3868f724a50ea2f894fb317b1b  packages/core/src/adapters/fog/unitOfWork.ts
e3585b4a0931eadb69ae372e062286bb4d1614ceffa4c4f1f041500869f4d42c  packages/core/src/adapters/libsql/migrations/0000_smiling_kree.sql
c077a39ac960030e215407532379753bbbe227213846a1283b40cef271bf7ee3  packages/core/src/adapters/libsql/migrations/meta/0000_snapshot.json
63d460b9fca7ba3e7f5089af1f6af4853a07b2bf5826ae64fa0ef11dd469420c  packages/core/src/adapters/libsql/migrations/meta/_journal.json
1e28de33411f36c3f4292dc3f6f126c1b85fc1558b40392fe1a012ddfac3b824  packages/core/src/application/fog/contentSupport.ts
0070475422e76d3d4d7a8b2a0b3c5fe7a97cf2ccf2d689f0000992c905b93932  packages/core/src/application/fog/documentServices.ts
a24a087ca6cd1b55d8f57eca9731e3b67bd7c94d20b773f14d4d45e0a81a71ae  packages/core/src/application/fog/memoServices.ts
919e53e7934597264988757cc4c842cfc6c5a5a45623a88c01f684bed693b99c  packages/core/src/application/fog/ports.ts
bbedf8c7f96349030f6c0a73eba4c4274e99caad26578adfc7e561813275de04  packages/core/src/application/fog/runtime.ts
fde64d1e48103ba15228400af419f6ee4b113a78ddbdf52c811ac900c3a3332b  packages/core/src/application/fog/services.ts
f9c63ec5fe1963f77052f13e12dd729f86cd06bb4915324ab11de46098c08969  packages/core/src/application/fog/topicServices.ts
55d8856c36ab29286997f97e9ce780b59afd25c8df8b53e2d32e8d1f9f263fc0  packages/core/src/application/fog/types.ts
0aeb748950d86b10fc211b1cf63c62b4fbd3143e71a680e52036e18fec0c9b23  packages/core/src/config.ts
f8d402bb3aab8e0a77d08c956c452a51998796a7b2a5f205186bff5f78526c39  packages/core/src/domain/fog/content.ts
c05f4c5732d24cb5648c2498e0254c377b31c0c0f854302fac2c88c5abdfb59d  patches/@tanstack__router-core@1.169.2.patch
a291a807c8bcf760234b7303abb672a2a11c536f313362e0fae621d046915634  pnpm-lock.yaml
91a0efd231c962cf5730e0842bf255386ba4f16e4e7886cd5985418ec38afa42  pnpm-workspace.yaml
ac92ea2abf24cf1bd2d1f8b605c22966f0c29522ae49de71e5fb6e6bef0cbb4c  vitest.config.integration.node.ts
```
