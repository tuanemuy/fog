# P3 core 独立検証

検証日時: 2026-09-05T11:23:00.149158+00:00。担当: `/root/p3_core_review`。対象: R10〜R15 の domain / application / libSQL schema・adapters。担当範囲 PASS。修正を要する不具合なし。UI・ブラウザ・Node worker起動配線は別 Verifier の担当。

## 対象識別

基準 HEAD は `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。未コミットを含む [P3-target-hashes.json](../phases/P3-target-hashes.json) の122対象をSHA-256と削除状態で照合し、122一致・相違0。削除15件はJSONのsha256=nullと実ファイル不存在を照合した。照合時刻は2026-09-05T11:20:50.739061+00:00。レビュー中に製品コードを変更していない。ブラウザ・サーバー・開発DBを操作していない。

正本は [brief](../brief.md)、[design](../design.md)、[plan](../plan.md)、[requirements](../../spec/requirements.md)、scenarioのtrash/search/settings/timeline/document。完了候補は [P3](../phases/P3.md) と [P3-core](../phases/P3-core.md)。レビューした実装は `domain/fog/{content,data}.ts`、`application/fog/{dataTypes,ports,contentSupport,memoServices,documentServices,topicServices,trashServices,searchServices}.ts`、`adapters/fog/{schema,unitOfWork,dataRepository,contentRepositories}.ts` と対応integration tests。

## 要件別判定

| ID | 判定 | 根拠 |
| --- | --- | --- |
| R10 | core PASS | 三種のsoftDeleteは所有者・ID・版・非削除を条件とし、topicとその時点の稼働中文書に同じ削除groupを設定。先行個別削除文書のgroupと日時は保持。trash DTOに削除日時・親状態・正確なsetDocumentIdsを投影し、注入時計と保持期限から残日数を算出。group削除途中の故障で親と文書が全てrollbackする実DBテスト成功 |
| R11 | core PASS | topic復元は同owner/topic/groupだけを対象とし、先行個別削除文書を保持。文書から削除親を戻す際は明示確認必須。親完全削除後はmissing型の文書を維持し、同ownerの稼働中topic選択または新規作成で復元。別owner・不正新規titleは拒否。独立故障注入で新規親作成後の文書復元失敗時に親作成もrollback。メモの作成日時・履歴・出典再接続、復元失敗の集合rollbackを確認 |
| R12 | core PASS | 人間専用runtime検査後、trash内の所有者一致対象だけを完全削除。topicは同groupの文書を履歴ごと削除し、先行個別削除文書はtopic_id=NULLで保持。FK cascadeでmemo/documentの履歴と出典を削除。完全削除の途中故障で履歴と孤立化前の親参照を復旧。独立emptyTrash故障注入でも既に削除した文書・履歴・出典がrollbackし、全三項目を保持。稼働中の完了topicと別ownerは消えない |
| R13 | core PASS | 保持期限は既定30日、domainで1〜3650の整数に限定。設定はowner範囲で更新。purgeExpiredTrashは利用者用サービスの外にあり、注入時計・全ownerの現在設定でdeletedAt + days <= nowだけを削除。同一transactionで履歴とリンクも消す。境界1ms前は0件、境界は該当3件、別ownerは残り、別ownerの期限短縮後は既存項目を削除。稼働中の完了topicは保持 |
| R14 | core PASS | Actor共用searchで最新memo本文・documentタイトル/本文を検索。ownerを全SQLに適用し、trashと削除親を除外、完了topicを含む。topic scopeは配下稼働中文書とその出典memo。日本語・編集直後・空query・literalワイルドカード・query/scope拘束cursorを確認。createdAt/id/kind降順keysetは同時刻・途中挿入・編集で重複欠落なし。snippetは原文部分文字列、sourceIdsは稼働中だけ。独立試験で長文の一致箇所を含む200文字snippetとAI秘密非漏洩を確認 |
| R15 | core PASS | 人間専用exportはownerの最新稼働中memo/topic/documentだけを取得。完了状態と稼働中出典ID、形式名・version・出力時刻を保持。履歴やownerを出力しない。独立試験でdocument編集前本文・変更理由・削除topic配下document・削除出典ID・別ownerのtopic/documentを含めず、最新title/bodyだけが出ることを確認 |

## 人間 / AI / 所有者境界

全取得と更新のrepositoryはactor.userIdで構築し、参照JOINはownerを含む。trash/restore/hardDelete/emptyTrash/settings/export/history/rollbackはHumanActorに加えrequireHumanのruntime検査を通る。型を迂回したAI呼び出し11操作を拒否する実DBテストが成功。softDeleteとsearchは認可AIの共有操作。

人間の墓標はdocumentView/memoViewで表示用に保持し、AIはdeletedのsource全体をfilterする。単体取得だけでなく、作成・編集の戻り値、topic配下document、関連memo、listMemos、timelineにも同じ投影を使用する。検索は別途sourceIdsで削除対象を除外する。独立試験では削除memoの本文・IDがAI編集戻り値、topic関連取得、search結果のいずれにも含まれず、削除documentもAIメモ編集戻り値とlistMemosから除外された。削除対象の直接取得はNotFound。P4のHTTP認証・冪等性キャッシュ再応答は未実装のため、この報告の合格範囲に含まない。

## 独立実行

```sh
pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__
pnpm exec vitest run --config .goal-implement/reviews/P3-core-vitest.config.ts
```

- 2026-09-05T20:19:14+09:00: 3 files / 32 tests PASS、exit 0、10.14秒。既存P1/P2回帰とP3追加16件を含む。
- 2026-09-05T20:21:17+09:00: 独立追加1 file / 4 tests PASS、exit 0、2.46秒。fixtureと故障注入は [P3-core-independent.test.ts](P3-core-independent.test.ts)、設定は [P3-core-vitest.config.ts](P3-core-vitest.config.ts)。すべて新規temp libSQL DBを作成し終了時に削除。
- 追加harness初回はlibSQLを相対パスで読み、製品側とモジュールinstanceが重複したため、故障時のLibsqlError instanceof判定により期待error codeと相違した。harnessのaliasを同一実体へ統一して再実行し4件成功。製品コードの修正なし。
- 旧nonnullable schemaのmigrationを実DBで実行し、document・revision・source保持、再実行、移行後の孤立文書作成、foreign_key_checkが成功する既存testを確認・再実行した。移行は同一write batchで再構築する。

全体typecheck/lint/format/unit/integration/buildの候補根拠は [P3](../phases/P3.md) にあり、122対象一致により同じ候補の検証として利用可能。担当範囲で不必要な全体再実行は行っていない。

## 残る検証

ブラウザ表示・確認ダイアログ・ダウンロード・Node workerのHTTPなし起動/周期実行は別Verifierへ委譲済み。この報告単独でP3全体やR18のAI HTTP隔離を完了と扱わない。担当core範囲の未検証必須項目・既知不具合なし。
