# P4b core 独立検証

判定: **R19/R20 の local core PASS**。担当範囲の必須不具合は検出していない。実 Google・外部 SMTP、Web/HTTP/UI/browser は本報告の合格対象外であり、R19/R20 全体の done を意味しない。

検証者: Manager 直轄 Verifier `p4b_core_review`。実装への参加なし。2026-09-05T13:28:03Z〜2026-09-05T13:30:56Z にコード照合と実行検証を実施した。

## 対象と方法

正本は `spec/requirements.md`、`spec/scenario/account.md` の S-AC-02/S-AC-07、`.goal-implement/brief.md`・`design.md`・`plan.md`。候補報告 `phases/P4b.md`・`P4b-core.md` を要件と照合した。

HEAD は `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。`phases/P4b-target-hashes.json` の177対象は開始時と終了時の双方で SHA-256 が一致した。終了時記録と実行証跡のhashは [P4b-core-evidence.json](P4b-core-evidence.json)。

domain account/content、application account/google/recovery/session/dispatcher、account port/type、libSQL repository/schema/UoW、crypto をレビューした。Google signature/token の具体 adapter、SMTP adapter、HTTP、UI、開発DB・ブラウザ・serverは操作していない。製品コード・製品テスト・Manager台帳は変更していない。

## 要件別判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| R19 初回/再ログイン | local core PASS | 初回は user と Google subject を同じ write transaction で作成。subject と primary email のDB一意制約を確認。既存 subject の再ログインは primary email を変えない。75件内 account 試験で同subject/同emailの競合・credential INSERT失敗rollback・同callbackの1勝者を再実行した。 |
| R19 明示連携/解除 | local core PASS | link は保存 owner と callback actor を照合し、既存sessionを更新しない。自分・別ownerで既存subjectを拒否。解除はowner照合と最後の手段検査を同一UoWで行う。並行解除後も1手段が残る。password credentialの解除操作は公開されていない。 |
| R19 state/交換契約 | local core PASS | state/browserはhash保存、10分期限、login/link判別とactor拘束。nonce/verifierをportへ渡しPKCE challengeとの一致を試験。外部交換前後に要求を再検査し、成功/取消の単回消費でnonce/verifierを消去。独立試験で交換中に別DB clientからresetを確定するとlinkを拒否しcredentialを作らない。 |
| R20 通常password変更 | local core PASS | 現在password照合必須、SSO-only拒否。全旧session削除と新session保存は同じUoW。既存AI接続は維持しpending grant/link/reset/mailを失効。独立した2つのDB clientによる同一旧passwordの変更競合は1勝者、旧session無効、新passwordと新session有効。 |
| R20 復旧依頼 | local core PASS | 未登録・SSO-only・password・制限中は同じ定数本文。3回/15分、token30分。token照合表にはhashのみ保存。tokenと配送payloadを同時確定しmail INSERT障害時rollback。配送成否は依頼の応答から分離される。 |
| R20 復旧完了/AI | local core PASS | 期限境界と単回/同時完了、全旧session無効、新session即時有効、旧password拒否を実DB確認。初回はaccount作成以降、以後は前回reset時刻以上のAIを失効し、より古いものと他ownerを保持。AI全失効はpending grantも削除し、Google linkを維持する。 |
| R20 失敗原子性 | local core PASS | 既存試験のAIを含むrollbackに加え、独立試験で最終session INSERTにDB trigger障害を注入。password/session、pending AI request/code、Google request秘密、queued mail、reset token、last reset状態の全rowが失敗前と一致。障害解除後の同tokenによる成功とpending秘密消去を確認。 |
| R20 メールworker | local core PASS | 60秒leaseとlease token付きack/retry、期限切れclaim回収、backoff、安定message IDを確認。独立試験で期限切れ旧leaseの遅延成功/失敗が新leaseを削除・解放しない。SMTP port呼出し中に別DB clientのresetが完了するため、外部配送中にtransactionを保持しない。 |
| R20 秘密の消去 | local core PASS | 成功配送、期限切れcleanup、reset消費、通常password変更でmail payloadを削除する。mailerなしでも期限切れtoken/mail/Google requestを削除。配送中にresetした場合、既に取得済みのURLが届く可能性はあるが、そのURLは単回token照合で拒否されDB payloadは残らない。 |
| 共通 暗号/ログ/境界 | local core PASS | cryptoは32-byte random token、SHA-256 token hash/S256、random salt付きscryptと定数時間比較。保存hash形式を厳格検査。account操作はruntimeでもAI actorを拒否する。レビュー対象のusecase/dispatcherに秘密を出すlog呼出しはなく、workerは配送例外の内容を記録しない。concrete adapter/HTTP側ログは別Verifier対象。 |
| 共通 永続化維持 | local core PASS | 既存75件内で反復migration後のSSO/reset/content/AIとforeign key check、旧nullable変更migrationで文書・履歴・出典の保持を確認。 |

## 実行結果

- `pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__/account.integration.test.ts packages/core/src/adapters/fog/__tests__/ai.integration.test.ts packages/core/src/adapters/fog/__tests__/content.integration.test.ts packages/core/src/adapters/fog/__tests__/data.integration.test.ts packages/core/src/adapters/fog/__tests__/services.integration.test.ts`: **5 files / 75 tests PASS**、22:28:03 JST開始、20.17秒。[ログ](P4b-core-existing.log)。
- `pnpm exec vitest run --config .goal-implement/reviews/P4b-core-independent.config.ts`: **1 file / 5 tests PASS**、22:29:59 JST開始、10.32秒。[ログ](P4b-core-independent.log)、[独立harness](P4b-core-independent.test.ts)、[専用config](P4b-core-independent.config.ts)。初回はreviewsからのpackage解決設定がなく0 testで停止した。専用configのalias修正後に全5件実行・成功しており、製品不具合ではない。

各testはOS temp directoryにlibSQL DBを作り、終了時にclose/removeした。追加harnessは2つの独立libSQL clientと本物の暗号adapterを使用した。秘密token・URL・password値を実行ログへ出力していない。既存成功済みのroot typecheck/lint/format/buildと外部adapter試験の再実行はこの担当範囲に含めない。

## 残条件と停止

GoogleIdentityPort と ResetMailer を制御可能なportに差し替えたlocal coreの検証である。実Googleの登録client/redirect/許可アカウントと実SMTP認証/送信元/配送到達性は未検証。Webのcallback cookie/origin/bearer、画面、完了後の2一覧は別Verifierの結果が必要。

製品の修正差し戻し事項なし。報告・harness・ログ以外の変更なし。実行中検証なし、書き込みと追加操作を停止した。
