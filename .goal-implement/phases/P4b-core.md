# P4b core 完了候補

対象は R19/R20 の core port・usecase・libSQL persistence。独立受け入れ前の完了候補。Google/SMTPの具体adapter・Web/HTTP・browserは親 Implementer が担当する。

## 実装

- Googleの開始はstate/nonce/PKCEを生成し、10分のstateをbrowser token hashとlogin/link mode・owner・相対returnToへ拘束する。callbackは外部identity交換をUoW外で実行し、交換後にstate期限・browser・actorを再検証する。成功/取消は単回処理し、消費済みstateのnonce/verifierを消去する。
- 初回SSOはGoogle subjectとprimary emailの両方を同一UoWで確保する。emailが既存の場合は自動連携せず拒否する。既存subjectでのログインはprimary emailを変更しない。明示linkは既存human sessionを維持し、自己/他ownerを問わず既存subjectを拒否する。
- 認証手段一覧はpassword有無とGoogle連携の解除可否を返す。Google credential削除はownerと最後のログイン手段を同一transactionで検査する。SSO-only userにpasswordログイン手段を作らない。
- 通常password変更は現在password確認後、全sessionを失効し新sessionを発行する。既存AI接続を維持する。pending reset token/mailと、旧sessionで開始したpending AI grant/Google link stateを無効化する。
- reset依頼の本文はpassword user・未登録・SSO-only・制限中で同一。3回/15分の制限と30分tokenを使用する。tokenはhashだけを保存し、メールpayloadを同じUoWでoutboxへ追加する。SMTPは依頼処理から分離する。
- reset完了はpassword更新・全session失効・新session発行・全reset token/mail消去・last reset記録・AI cutoff失効を原子的に確定する。初回はaccount作成以降の接続、以後は前回reset時刻以降（境界を含む）の接続を失効する。それより古い接続・他owner接続は維持する。
- AIすべて失効はownerの現行接続とpending AI grantを無効化する。Google linkへ副作用を与えない。
- reset email dispatcherは60秒lease、安定message ID、失敗backoff、期限切れlease再取得でat-least-once配送する。成功時はpayload行を削除する。mailer未設定でも期限切れmail/token/Google stateを掃除する。SMTP中にDB transactionを保持しない。
- account/credential/human変更操作はruntimeでもAI actorを拒否する。既存password登録/loginとAI operationsの契約を維持する。

## 検証

- `pnpm --filter @repo/core typecheck`: 成功。
- scoped `pnpm exec biome check --write` / 最終 `biome check`: 所有する変更対象31ファイルで成功。親担当Google/SMTP adapterを変更していない。
- `pnpm exec vitest run --config vitest.config.integration.node.ts` に所有するfogの5 integration testファイルを指定: 最終 5 files / 75 tests 成功。account追加21件、既存54件。
- 実SQLiteでSSO初回/再login、primary email維持、自動link拒否、明示link、state/browser/actor/期限/returnTo、取消、外部交換中の独立UoW操作と交換後期限再検査、同subject/同email/同callback競合、credential作成失敗rollback、最後の手段の並行解除を確認した。
- reset同一応答/制限、tokenとmailの原子性、hash保存、配送後payload削除、失敗retry/安定ID、mailer不在cleanup、複数dispatcher lease/クラッシュ回復を確認した。
- reset期限/単回/同時完了、全session rotation/即login、旧password拒否、AI cutoff境界/初回全失効/他owner維持、最終session作成失敗の全rollback、通常password変更、queued token失効、pending grant無効化とAI-all操作の影響範囲を確認した。
- 繰り返しmigrationで既存content・履歴・P3設定・AI接続・SSO・reset queueを保持する。

Google identity交換とメール配送はテストportで検証した。実Google・SMTP adapterのJOSE/署名/送信、HTTP cookie/origin/bearer境界、UI・ブラウザ・メール受信は親担当の報告と独立検証で受け入れる。

## 実行・引き継ぎ

`accountTypes.ts` / `accountPorts.ts` が共有契約。`createFogServices` に `googleIdentity` とNodeの `appUrl` を渡す。reset linkは `/password/reset?token=...`。SSO callback routeはWebが管理する。

`resetEmailDispatcher.ts` の `dispatchResetEmails({unitOfWork,clock,ids,mailer?,limit?})` を定期実行する。mailer未設定でもcleanupを実行する。親Node wiringは5秒周期を採用する。SSO concrete port未設定時はGOOGLE_UNAVAILABLE。既存 `migrateFog` が追加tablesを作成する。

core範囲の既知の不具合・未完了項目なし。root checks・実サービス・Web統合を完了扱いにしない。全体goal・Manager台帳・server/browserは操作していない。コード書き込みと実行中検証を停止し、独立検証または具体的な修正依頼を待つ。

## 対象記録

日時: 2026-09-05T12:36:21.271174+00:00

HEAD: `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。既存未コミット成果を含むcore所有対象を記録する。親担当 `googleIdentity.ts` / `smtpMailer.ts` とそのtest、package.jsonは対象外。

| ファイル | SHA-256 |
| --- | --- |
| `packages/core/src/adapters/fog/__tests__/account.integration.test.ts` | `e294259e4ef9811690f6aaf1cee4e937f7c7ff34a322be88d83e82614e397b95` |
| `packages/core/src/adapters/fog/__tests__/ai.integration.test.ts` | `e162cb7d15a36c4329947f41d0305c702ec24c47cc7c98f9d2836a71bab05925` |
| `packages/core/src/adapters/fog/__tests__/content.integration.test.ts` | `8bcc832ce9ef8237dc4245d97ea3e3d71c21e204af3f5adcd34e67603c8bb3b0` |
| `packages/core/src/adapters/fog/__tests__/data.integration.test.ts` | `84be18bd96beda3b8afa33a2ae2e79c1750cde9f245a9b1a0ebd66650f8ff179` |
| `packages/core/src/adapters/fog/__tests__/services.integration.test.ts` | `7d0596b459f471e134c91267dede92d29fb9e9209c5d43dc7fd8950b7ac4a66c` |
| `packages/core/src/adapters/fog/accountRepository.ts` | `8a9dcf56ac84f90b59e35a9b763e5df430d981689d66d5c310546577f8956953` |
| `packages/core/src/adapters/fog/aiRepository.ts` | `36a8155b75375f3beb16d97ba4d4cbb9cee5ce5b67814daf9f2f6ff4cdaa6c6e` |
| `packages/core/src/adapters/fog/contentRepositories.ts` | `e5373f477573dfef39a0f1afb6913c61ae5a3cd1c63b532cbf2336029db330f4` |
| `packages/core/src/adapters/fog/crypto.ts` | `f6abc4fdd250d62b7bf6ed06b74b746ea8916049c4c13c7b0e8047735c36cb0e` |
| `packages/core/src/adapters/fog/dataRepository.ts` | `554dbcb9ed3a1d3f99df9786fb9d0f97234702d783b82bc346430d43d7258f76` |
| `packages/core/src/adapters/fog/schema.ts` | `bd1ef6a7907dd9554b1fe1a91e5338cc2447795f530e0976981bb9af4f34ccbd` |
| `packages/core/src/adapters/fog/unitOfWork.ts` | `0e260cc0271547739fca64690d21b9d695d271ed421e31e151522cac0a1ec5dc` |
| `packages/core/src/application/fog/accountPorts.ts` | `d9058ac2a5e4245738d89b642ad5011a5ddebbb7bd5ab831ea0d33916da06876` |
| `packages/core/src/application/fog/accountServices.ts` | `394fbef8b89368fa3dae56e520c0d4cf0ea2c6b133771349da712bb353fea4c4` |
| `packages/core/src/application/fog/accountSupport.ts` | `0a77058f146fee19bbfb0b62388df5ae19ab9eb4b605666319c1e8567c992f7a` |
| `packages/core/src/application/fog/accountTypes.ts` | `47d67f595316d94548d8a4d63fdd024f998b4aa656716448b2459e758ffcb65d` |
| `packages/core/src/application/fog/aiOperations.ts` | `7132c25f3f5bc3c0aea06406d016d7e95ea76604333314fa63ca198709f689bd` |
| `packages/core/src/application/fog/aiPorts.ts` | `ea5aa2f1f3fbe91868626db7f5dd729d2c62d61504d7cb5a05f8db5da18f769c` |
| `packages/core/src/application/fog/aiServices.ts` | `f267dc21afb0c2158d447a93a24a91cb4b999dee3733b6fe3b4bf1ac8643a013` |
| `packages/core/src/application/fog/aiTypes.ts` | `d0b65ba1fb0f25cb720fa00e1e3c0ba25d3c23452e4e0b1592c4dc56e8416669` |
| `packages/core/src/application/fog/contentSupport.ts` | `395e8c276eb90d92f568dc65dd29530f8c185b33c9e9ef5fcdca344e646e2778` |
| `packages/core/src/application/fog/dataTypes.ts` | `bd44cbae41797b5fd20fcdbceaea763d2443e8593057ae2f046b77771247d21b` |
| `packages/core/src/application/fog/documentServices.ts` | `a2bc85cd42e7b191002d5f6e946a884419dd0fa893551f7a31e62dc28e4d75b7` |
| `packages/core/src/application/fog/googleServices.ts` | `498bf8097e46eed21a67fb05b43218bd626dd9fe4650e55c8341c89cbc14d080` |
| `packages/core/src/application/fog/memoServices.ts` | `a05352388ad763831839fe16b8d0222cbeba13545e9a3722471477e785b8235e` |
| `packages/core/src/application/fog/ports.ts` | `af8c4dc9db1234869c07f326b19d68ec8bf0635cca38b6356771f2f90811c813` |
| `packages/core/src/application/fog/recoveryServices.ts` | `372862032a59f5fdfa098ab82671a57a7c345b27e650d24ca3ba6d37faf5854d` |
| `packages/core/src/application/fog/resetEmailDispatcher.ts` | `6a8f00fcc7539768b9fdb880b0c2176f1a6ac2ddc439fbb9383f37b128d1e678` |
| `packages/core/src/application/fog/runtime.ts` | `bbedf8c7f96349030f6c0a73eba4c4274e99caad26578adfc7e561813275de04` |
| `packages/core/src/application/fog/searchServices.ts` | `c6d861077d40d0497a671ef2d0b9c7c1ac4512484b10414c87536893930f937a` |
| `packages/core/src/application/fog/services.ts` | `27cf32cff4c76f9837c95d915ece95b97bb70be2c828467632dc228b330ccd44` |
| `packages/core/src/application/fog/sessionSupport.ts` | `c00c5256509629abe3609c5dbcd33334cb57658cf7b501ba43747f87d2e54daa` |
| `packages/core/src/application/fog/topicServices.ts` | `d8eff69707b0233f8ac4f3c821867263c9a0b57e00efb546114a95322078d2df` |
| `packages/core/src/application/fog/trashServices.ts` | `7a2341bb1b986abaebd3fdfb53ed52982d165ffc2ee32a7c3ddf754758f392f3` |
| `packages/core/src/application/fog/types.ts` | `f355f448e8789dc49e04b0563216081814ad34ef4c612429bce62374a75cbae8` |
| `packages/core/src/domain/fog/account.ts` | `c2627f2509cfa13a7f7ea9c639152ee87c6e90914150587d8d9904405df32312` |
| `packages/core/src/domain/fog/ai.ts` | `ff912914ced62d97d78bd902994207e02b77d84d2f2702e0fd88342d6cf2f4c8` |
| `packages/core/src/domain/fog/content.ts` | `f8d402bb3aab8e0a77d08c956c452a51998796a7b2a5f205186bff5f78526c39` |
| `packages/core/src/domain/fog/data.ts` | `5d46967e30fb15b3e202c6232939066a15ef6a71c619fec589f3f685b21d329c` |
