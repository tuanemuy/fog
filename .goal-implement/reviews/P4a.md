# P4a 独立検証

日時: 2026-09-05T21:03:00+09:00〜2026-09-05T21:12:34+09:00。対象 R16〜R18。判定は PASS、Manager の受け入れ待ち。製品コードと管理台帳は変更していない。

## 対象と根拠

[P4a候補](../phases/P4a.md)、[142対象hash](../phases/P4a-target-hashes.json) を照合し、開始時・終了時とも全SHA-256/削除状態一致。HEADは `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。候補の typecheck/lint/format、109 unit、Node84/CF70 integration、build成功根拠は現在対象に適用可能。HTTP境界9 unitを21:04:58に独立再実行し成功した。

coreの結果は [P4a-core](P4a-core.md) を参照。既存54＋独立4 tests、別OS processのcode交換単回/書込単回/再起動replay、ledger障害rollback、人間専用拒否が独立合格。

環境は dev PID99712/exec28369、http://localhost:3000、登録client `fog-local-client`。agent-browser `fog-p4a-review` と127.0.0.1:3456のlocal CLI callbackを専有。humanは既存 `p4-owner-20260905@example.test`。既存データを保持し、新しい認可・APIテストデータを追加した。

## 要件の合否

| ID | 判定 | 独立検証 |
| --- | --- | --- |
| R16 | PASS | client CLIでstate/PKCEを生成して認可URLを開く。未ログインでloginへ誘導、login後consentへ復帰。15操作と人間専用の除外、戻り先を表示。拒否callbackで接続せずcredentialなし。新要求の許可後にstate照合/PKCE交換、mode0600 credentialを保存。無効requestはエラーと設定リンクのみ、許可/拒否なし。settingsにclient名/接続/最終利用を表示し、確認付き解除で空案内へ戻る |
| R17 | PASS | [API smoke](P4a-api-results.json) 19実HTTP checksを独立実行。memo作成/全文置換、topic作成/更新/完了、source付きdocument作成、理由付きpatch、明示rewrite、recent/get/topics/searchを確認。一致なし422、古い版409、不在source404、他owner404、異payload key409。人間historyはAI名/時刻/理由3件、UI rollbackでhuman版4を追加しAPI最新本文も元本文へ戻る |
| R18 | PASS | [追加HTTP](P4a-extra.json) 19checksで不許可操作/owner注入422、cookie+Bearer403、media415、guidance/no-store、並行同一要求4件で作成1/replay3。AI softDelete後にhuman文書は墓標、AI document/topicはdeleted source本文・IDなし、get404、create replay resource null。human復元後の成功済みdelete replayは再削除しない。[失効検証](P4a-revoked.json) はread/new write/successful replayをすべて401拒否 |

## HTTP・presentationのレビュー

`/api/ai` はBearerだけ、Cookie付きは拒否、operation/inputをstrict unionで検証する。unknown下位pathは404、POST method、query禁止、JSON/content-type/body上限と安全なerror responseを持つ。人間server functionsはAuthorizationを拒否し、Originとセッションを検証する。

[実境界8件](P4a-boundary.json) で、異Origin/空Origin consent403、Bearer付きlogin/register403、Bearerをhuman cookieへ偽装した投稿401、Bearer+human cookieのemptyTrash403、cookie-only API403、未登録redirect401/Locationなしを独立確認した。未知操作、未知owner field、混在credential、media415は追加実HTTPでも検証した。期限/owner拘束/PKCE不一致/単回交換/partial editの原子性はcore独立結果と照合した。

consentはCookie人間の決定だけで外部redirectし、credentialをURLへ載せない。接続解除の一覧ownerはoptimistic除去、失敗errorとconfirmationを保持し、完了時invalidateする。AI履歴/ゴミ箱/復元/完全削除への迂回はhuman境界とAI operation unionの両方で拒否する。

再起動後receiptは候補 [restart-replay](../phases/P4a-evidence/restart-replay.json) と現在hashを照合した。active作成receiptのID/version1維持、削除済みresource nullを確認。今回も実HTTP4並行とcore別OS processの独立試験を確認しており、同じproduction再起動操作を繰り返していない。

## 人間による復元

追加document `01a07177-7231-77ca-be58-0f9cc157127e` の3件のAI履歴を直接URLで表示。版1を選択して復元すると版4となり、単体APIも元本文/version4を返す。追加memo `01a07177-7201-7044-8126-f4ec674af862` をAIからsoftDeleteし、人間の文書には「削除済みのメモ」、AI DTOにはsource IDなし。trashから人間UIで復元後、同じdelete要求をreplayしても再削除しない。[復元後HTTP](P4a-human-restore.json)。

## PC・スマホ

[PC consent](P4a-consent-desktop.png)、[mobile consent](P4a-consent-mobile.png)、[mobile connections](P4a-connections-mobile.png) を撮影し、開いて確認した。PC1440×1000、mobile390×844。15操作と除外/許可拒否、接続名/時刻/解除の表示を確認。mobile documentWidth=innerWidth=390。human rollback、trash復元、接続解除はmobile幅で完了した。

## local callbackの単発観測

最初の拒否の直後、同じbrowser/同じcallback portでCLIを再起動して次の許可を行った際、callbackが「認可応答を確認できません」を一度表示した。新しいCLIのstateとcallback queryのstateは一致し、callbackには単一codeがあることを値を出力せず照合した。callbackをreloadすると交換が成功し、mode0600 credentialを保存した。

同じ条件で新しいCLI→拒否→同portの新CLI→許可を再試験した結果は、reload不要でstate照合・交換・保存まで成功。初回事象の時点で新listenerは稼働し、Chromeに旧callback接続も残っていた。古いkeep-alive接続の再利用による環境残存を疑うが原因は未確定で、安定再現するfixture不具合は確認していない。Manager指示に従い受け入れ阻害とせず、この観測を保持する。製品API/code交換/認可状態の独立結果は正常である。

## 終了と引継ぎ

- 2回の許可で作成した接続は両方とも設定UIから失効し、一覧は空。
- 最初のcredentialでread、新規write、成功済みreplayの3種類が401 `AI_CONNECTION_UNAUTHORIZED`。
- 追加topic `01a07177-7229-75e8-b603-58e0850bb23c` は完了済み。追加documentはhuman rollback後版4。追加memoは復元済み、並行試験memo1件を保持。
- Bearerとsession cookieは/tmpの所有者専用ファイルだけに置き、報告へコピーしていない。Bearerは失効済み。
- browserをclose、callback3456 listenerなしを確認。dev PID99712/exec28369は保持し、環境操作を停止。

R16〜R18に未検証必須項目・既知の製品不具合はない。P4bのSSO/復旧と外部実サービス、P5の運用・統合完了は含めない。
