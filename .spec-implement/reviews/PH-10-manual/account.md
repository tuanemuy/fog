# account.md 実走結果（PH-10）
- 実行: 2026-09-11T07:48+09:00〜（進行中）、環境 dev :3000、HEAD 9f5671e、agent-browser session ph10-account
- テストアカウント（手順書の値 → 実際に使った値）:
  - `test@example.com` / `password123` → `ph10-account-main@example.com` / `password123`
  - SSO テスト用 Google アカウント → dev スタブ subject `ph10-account-sso-1` / email `ph10-account-sso@example.com`
  - TC-18 用（main と同じメールの Google） → subject `ph10-account-sso-18` / email `ph10-account-main@example.com`
- 集計（最終。表の下の「Implementer の再走」節の判定が優先）: 合格 46 / 部分実施 1（TC-47: bucket 単位の RPC 障害を起こせないので sqlite シードで終端モード・poison・requeue を観測）/ 不合格 0（全 47）

| TC | 種別 | 判定 | 備考 |
|---|---|---|---|
| TC-01 | 正常系 | 合格 | `/` → `/login`。メール・パスワード欄、Google/Apple ボタン、「アカウント登録」「パスワードをお忘れの方」リンクあり |
| TC-02 | 正常系 | 合格 | `/signup` から登録 → `/` タイムライン（空状態）。reload 後もログイン維持。確認メールは `[dev-mail]` に無し |
| TC-03 | 正常系 | 合格 | スタブで許可 → `/` へ。設定のメールアドレスが `ph10-account-sso@example.com` |
| TC-04 | 正常系 | 合格 | ログアウト後、同 subject で許可 → 既存アカウント（同メール）でログイン |
| TC-05 | 正常系 | 合格 | `/login` → `/` |
| TC-06 | 正常系 | 合格 | `/settings` の「セッション」区画の「ログアウト」→ `/login` |
| TC-21 | 異常系 | 合格 | SSO ユーザーのメール + `password123` → 「メールアドレスまたはパスワードが正しくありません」（TC-19 と同文） |
| TC-17 | 異常系 | 合格 | スタブで「キャンセル」→ `/login`（alert 無し）。再度押すとスタブに遷移できた |
| TC-18 | 異常系 | 合格 | `/login?sso_error=email_registered` に「このメールアドレスはパスワードで登録されています。パスワードでログインしてください」。同 subject で再試行しても同じエラー（SSO 主体は登録されていない） |
| TC-19 | 異常系 | 合格 | alert「メールアドレスまたはパスワードが正しくありません」。修正後にログイン成功 |
| TC-20 | 異常系 | 合格 | 未登録メールで同文。`invalid-email` はブラウザの HTML5 検証（`@` が無い）で送信前に止まる（登録有無は示さない）。`noValidate` で送るとサーバも同じ「正しくありません」 |
| TC-22 | 異常系 | 合格 | `/settings` → `/login?redirect=%2Fsettings`。ログイン後 `/settings` に戻る |
| TC-23 | 異常系 | 合格 | ログアウト後 `back` → `/login?redirect=%2Fsettings`（ログイン画面）。`/` → `/login` |
| TC-33 | 異常系 | 合格 | SSO のみユーザーの設定に「パスワードの変更」区画が無い。ログイン手段は「外部アカウント（google）ログインに使用 / 解除」と「メールアドレス 一意性の予約のみ」。AI 接続・ログアウトは表示 |
| TC-07 | 正常系 | 合格 | `ai-client.ts register --name "Test Client"` → `authorize` の URL を開くと P-14（`/ai-clients/authorize?request=…`）。「Test Client が、ph10-account-main@example.com として接続することを求めています」、許可される操作（メモ / ドキュメント / トピック / ゴミ箱へ移す）と「できないこと」（完全削除・履歴削除、ゴミ箱アクセス・復元・空にする、履歴閲覧・ロールバック）が明示。許可 → loopback にリダイレクトし token 取得。`call recent_memos` が 200。ボタンの無効化は遷移が速く目視できず、`AuthorizeSheet/index.tsx` の `disabled={pending}` / 「処理中…」で確認 |
| TC-08 | 正常系 | 合格 | 設定の「AI クライアント接続」に「Test Client / 接続済み: 2026年9月11日(金) / 最終利用: 2026/09/11 07:54 / 接続を解除」 |
| TC-09 | 正常系 | 合格 | 「接続を解除」→ ダイアログ「接続を解除しますか？」→「解除する」で一覧が空状態に。以後 `call` は 401 `invalid_token`、`refresh` は 400 `invalid_grant`「The connection is no longer active」。再認可（TC-26）で新しい接続として一覧に出る |
| TC-10 | 正常系 | 合格 | ユーザー `ph10-account-r1@example.com`。`/password-reset` で依頼 → `?sent=1`「登録されていれば、リセット用のメールを送信しました」。`[dev-mail]` は 1 通（QUEUE 1/1 ログあり）。リンク → 「新しいパスワードを設定」→ `/password-reset/done` がログイン済み（ナビ付き）で表示。ログアウト後 `newpassword456` でログイン可、`password123` は「正しくありません」。別セッション失効は agent-browser で別 cookie jar を作れず未観測（cookies get が空） |
| TC-11 | 正常系 | 合格 | main で `password123`→`newpassword456`：「変更しました」。旧 PW でログイン不可、新 PW でログイン可（以降 main の PW は `newpassword456`） |
| TC-38 | 正常系 | 合格 | `/password-reset/done` に (a) ログイン手段一覧（メール: 解除なし / 外部アカウント（google）: 「解除」あり）と (b) AI クライアント接続一覧 + 「すべて失効」が同一画面に出る。SSO「解除」→ 行が消え、その subject で「Google で続行」すると `sso_error=email_registered`（このアカウントへはログインできない）。「すべて失効」は 0 件状態で押下（後述の観察: リセット完了時点で直前世代の接続が自動失効済みのため、一覧は「接続はありません」）。設定でも同じ状態 |
| TC-27 | 異常系 | 合格 | TC-09 で 0 件にした後、設定の「AI クライアント接続」に「接続はありません。」と「LLM アプリで fog をコネクタとして追加すると…MCP サーバーの URL: http://localhost:3000/mcp」の案内。空の表・エラー無し |
| TC-28 | 異常系 | 合格 | 「接続を解除」→ ダイアログ →「キャンセル」で閉じ、行は残る。`call recent_memos` 200 |
| TC-24 | 異常系 | 合格 | 「拒否する」→ loopback に `?error=access_denied&state=…` が届く（ai-client 側は access_denied を表示）。設定の一覧に接続なし |
| TC-25 | 異常系 | 合格 | `client_id=tampered-client` → `/ai-clients/authorize?error=invalid_request`「認可リクエストが正しくありません。クライアントアプリからやり直してください」、許可ボタン無し。期限切れ: `request` トークンの `exp` は発行から 10 分で、07:57 発行の URL を 08:08 に開くと同じエラー（本物の期限切れで確認）。署名を改変した `request` も同じエラー。`state` の改変は client 側の opaque 値なので通る（署名対象外。妥当） |
| TC-26 | 異常系 | 合格 | ログアウト状態で認可 URL → `/login?redirect=%2Fai-clients%2Fauthorize%3Frequest%3D…` → ログイン後 P-14 に戻り、許可で token 取得・`call` 200 |
| TC-31 | 異常系 | 合格 | r1 の使用済みリンクを再度開き `anotherpass789` → 「リンクが無効か期限切れです もう一度依頼する」（期限切れと同文）。`newpassword456` でログイン可 |
| TC-32 | 異常系 | 合格 | main: 現在 `wrongpassword` → 「現在のパスワードが正しくありません」。`neverused789` でログイン不可、`newpassword456` で可 |
| TC-12 | 異常系 | 合格 | 空メール: ブラウザの `required` で「このフィールドを入力してください。」。`noValidate` で送るとサーバ側「メールアドレスの形式が正しくありません」（パスワード値は保持）。空パスワード: `required`、`noValidate` では「パスワードは8文字以上128文字以下で入力してください」（メール値は保持） |
| TC-13 | 異常系 | 合格 | `invalid-email` / `local@` はブラウザの type=email 検証で止まり、`noValidate` で送るとサーバ側「メールアドレスの形式が正しくありません」。`ph10-account-tc13@example.com` に直して登録成功 → `/` |
| TC-14 | 異常系 | 合格 | 登録済み main のメール → 「このメールアドレスは既に登録されています ログインする」。「ログインする」（`/login`）で `/login` へ |
| TC-15 | 異常系 | 合格 | `ph10-account-dup@example.com` でボタンを 3 連打 → 登録 1 回で `/` へ、エラー無し。無効化は `AuthForm/index.tsx` の `disabled={pending}` で確認（遷移が速く目視不可） |
| TC-16 | 異常系 | 合格 | `  Ph10-Account-Norm@Example.COM  ` で登録 → 設定のメールは `ph10-account-norm@example.com`。小文字でログイン可。`PH10-ACCOUNT-NORM@EXAMPLE.COM` で登録 → 「既に登録されています」 |
| TC-34 | 境界値 | 合格 | `abcd123` → 「パスワードは8文字以上128文字以下で入力してください」（`minLength` 属性は無く、サーバ側判定）。`abcd1234` で登録成功 |
| TC-35 | 境界値 | 合格 | 入力欄に `maxlength=128` があり 129 文字は入力段階で切られる（b2 は 128 文字で登録され、その PW でログイン可）。`maxlength` を外して 129 文字を送るとサーバ側「パスワードは8文字以上128文字以下で入力してください」（b3） |
| TC-36 | 境界値 | 合格 | 入力欄に `maxlength=320` があり 321 文字は切られる（b1 相当は 320 で登録）。`maxlength` を外して 321 文字を送るとサーバ側「メールアドレスの形式が正しくありません」。320 文字（`b`×308@example.com）で登録成功 |
| TC-39 | 正常系 | 進行中 | ユーザー `ph10-account-r5@example.com`。手順1: 接続作成 → 設定に active。手順2: PW 変更（`password123`→`newpassword456`）後も一覧に残り `call` 200。手順3: リセット完走（08:20）→ 完了画面と設定で「接続はありません」、`call` 401。手順4: 新しい接続を作成（08:20、active）。2 回目のリセットは窓（15 分）明けの 08:35 以降に実行 |
| TC-41 | 正常系 | 合格 | main（PW `newpassword456`）。手順1: メール行のみ・解除なし。手順2: subject `ph10-account-sso-link` / `ph10-account-link@example.com` で連携 → `/settings?sso=linked`、SSO 行に「解除」、メール行には無し、ログイン継続。手順3: その subject で「Google で続行」→ main（設定のメールが `ph10-account-main@example.com`）でログイン。手順4: PW ログイン可。手順5: 「解除」→ SSO 行が消える。手順6: 同 subject で「Google で続行」→ main には入れず（未登録メール `ph10-account-link@example.com` なので SSO 初回登録として**新規アカウント**が作られた。仕様どおり）。PW ログイン可 |
| TC-44 | 正常系 | 合格 | ユーザー `ph10-account-r7@example.com`（`list-bucket-user-ids` の差分で bucket `dir:g1:b10` と特定）。手順1: `read-delivery-backlog` = pending 0 / publishing 0。手順2: 依頼 → 即 `?sent=1`。手順3: 直後の読みは 0/0（relay 済み。増分は捉えられず。許容）。手順4: 約 30 秒後に `[dev-mail]` 到着。手順5: 0/0（手順1と同じ）。`list-quarantined-events` は空。`read-schema-version` = 1 |
| TC-29 | 異常系 | 合格 | `no-such-user@example.com` / SSO のみの `ph10-account-sso@example.com` / `ph10-account-r2@example.com` ×2（08:10:16, 08:10:23）の 4 回とも `?sent=1` の同文。メール: no-such 0 通、sso 0 通、r2 1 通（2 回目は送られない）。r2 の 1 通目のリンクは 2 回目の依頼後も再設定フォームを開けた |
| TC-30 | 異常系 | 合格（代替） | 期限切れリンクは用意できない（TTL の偽装は sqlite 要）ので r1 の使用済みトークンで代替: 「リンクが無効か期限切れです もう一度依頼する」（`/password-reset` へのリンク）。導線から `ph10-account-r3@example.com` で再依頼 → `?sent=1`、新しいメールが届いた |
| TC-40 | 異常系 | 合格 | ユーザー `ph10-account-r6@example.com`（SSO subject `ph10-account-sso-r6` を連携済み）。誤 PW ×6 とも同文、正しい PW でも同文「メールアドレスまたはパスワードが正しくありません」（ロック中を区別できない）。(i) リセット完走 → `/password-reset/done` がログイン状態。(ii) 再度 ×6 失敗 + 正 PW 失敗 → 「Google で続行」で r6 にログインできた |
| TC-43 | 異常系 | 合格 | 手順1: 別アカウント（`ph10-account-sso@example.com`）の subject `ph10-account-sso-1` で連携 → `/settings?sso_error=already_used`「この外部アカウントは既に別のアカウントに連携されています」、一覧不変。手順2: 自分で連携済みの `ph10-account-sso-link` でも同じエラー（no-op にならない）。文言が「別のアカウントに」なのは自アカウントの場合には少し不正確（観察） |
| TC-45 | 異常系 | 保留（sqlite 要 / dev 再起動要） | producer binding を落とす手段が dev（miniflare）に無い（`wrangler.toml` の queue binding を外すと dev 再起動が要る）。代替: 対象 bucket の sqlite で quarantined 行をシードして手順4・6 を確認する。SQL は末尾 |
| TC-46 | 異常系 | 保留（dev 再起動要） | メール provider を落とすには `MAIL_DEV_SINK` を外して（実 provider 未設定で consumer が失敗）dev を再起動する必要がある。`max_retries = 3`（`apps/web/wrangler.toml`）。DLQ の観測は dev ログ（`QUEUE tanstack-start-template-events-dlq`）と `[dev-mail]` で行う。手順の詳細は末尾 |
| TC-47 | 異常系 | 保留（sqlite 要） | cross-DO RPC を落とす手段が dev に無い。終端モード / poison の観測は sqlite で `jobs`（User Data DO 側 `kind='resume-link'`）を直接シード・読取するほかない。SQL は末尾。`list-poisoned-jobs` は `--locator <userId>` で呼べることは確認済みではない（未実行） |
| TC-37 | 境界値 | 合格 | ユーザー `ph10-account-r4@example.com`。`abcd123` → 「パスワードは8文字以上128文字以下で入力してください」（URL は `?token=` のまま）。同じ画面で `abcd1234` → `/password-reset/done`（トークン未消費）。「タイムラインへ」で `/`（TC-10 手順5 相当）。`abcd1234` でログイン可 |
| TC-42 | 異常系 | 合格 | 唯一の SSO の「解除」→ 「最後のログイン手段は解除できません」、一覧は不変。ログアウト後、同 subject で SSO ログイン可 |

## 不合格の詳細

## 保留ケースの SQL と前提

### TC-45（quarantined 行のシード。bucket は `dir:g1:b10` = `ph10-account-r7@example.com` の bucket、sqlite は `apps/web/.wrangler/state/v3/do/tanstack-start-template-state-IdentityDirectoryDurableObject/<hash>.sqlite` のうち `_meta.self_locator='dir:g1:b10'` のもの）
1. 窓が明けた状態で `ph10-account-r7@example.com` のリセットを依頼し、`outbox_events` に `status='published'` の行が 1 つできるのを待つ（`SELECT id,status,attempt FROM outbox_events ORDER BY created_at DESC LIMIT 1`）。
2. 隔離を偽装: `UPDATE outbox_events SET status='quarantined', attempt=5, terminal_reason='publish-failed: Error', completed_at=strftime('%s','now')*1000, next_run_at=NULL, lease_until=NULL, owner_token=NULL WHERE id='<id>';`
3. `node scripts/operator.ts list-quarantined-events --locator dir:g1:b10` で 6 列（`id/type/attempt/created_at/completed_at/terminal_reason`）だけが返り `owner_token/payload/aggregate_id` が無いことを確認。
4. `node scripts/operator.ts requeue-quarantined-event --locator dir:g1:b10 --json '{"eventId":"<id>"}'` → `SELECT status FROM outbox_events WHERE id='<id>'` が `pending`→`published` になり、トークンが TTL 内なら `[dev-mail]` が再送される（同じトークン URL）。TTL 超過なら `nothing-to-send` で何も届かない。
- 前提: dev 停止中に編集し、再起動後に Alarm が起きる（`next_run_at` を過去に置くと即時）。publish 失敗そのもの（producer binding 障害）は再現しない。

### TC-46（DLQ）
1. `.dev.vars` の `MAIL_DEV_SINK` を一時的に外し（実 provider キー無し → consumer の送信が失敗）dev を再起動。
2. 窓の明いたユーザー（例: 新規 `ph10-account-r8@example.com`）でリセットを依頼。dev ログに `QUEUE tanstack-start-template-events` の retry が `max_retries=3` 回出て、`QUEUE tanstack-start-template-events-dlq` に落ちるのを待つ。
3. 発行元 bucket の `SELECT status FROM outbox_events WHERE id='<event.id>'` が `published` のまま。
4. `MAIL_DEV_SINK="console"` を戻して再起動し、DLQ handler の 1 回再駆動（`queueHandlers.ts` の DLQ 自動 1 回）で `[dev-mail]` が届くことを確認。DLQ メッセージの中身はログに写さない。

### TC-47（終端モード / poison）
- 対象: `ph10-account-main@example.com` の User Data DO（`apps/web/.wrangler/state/v3/do/tanstack-start-template-state-UserDataDurableObject/<hash>.sqlite`、`_meta.self_locator` がその userId のもの）。`jobs` の `kind='resume-link'` 行を対象にする。
- 終端モードのシード（手順3 相当）: SSO 連携を開始して `jobs` に `resume-link` 行がある状態で dev を止め、`UPDATE jobs SET status='pending', attempt=0, next_run_at=<past ms>, terminal_reason='forward-exhausted: <reason>', completed_at=NULL WHERE kind='resume-link' AND operation_key='<key>';` → 再起動後、`list-poisoned-jobs --locator <userId>` に**現れない**こと、次の起床で後始末が走り `status='done'`（`terminal_reason` 残存）になることを確認。
- poison のシード（手順7・8 相当）: `UPDATE jobs SET status='poison', completed_at=<now ms>, terminal_reason='cleanup-exhausted: forward-exhausted: <reason>' WHERE operation_key='<key>';` → `list-poisoned-jobs` に 5 列（`operation_key/kind/attempt/completed_at/terminal_reason`）で現れ `payload` が無いこと、`requeue-poisoned-job --json '{"operationKey":"<key>"}'` で `pending` に戻ることを確認。
- cross-DO RPC の障害注入（手順1）は dev では不可（bucket DO を単独で止められない）。

## 観察（合否に関係ないが気付いたこと）
- 設定画面（P-13）と完了画面（P-03 done）の AI クライアント一覧は失効済み（revoked）の接続を表示しない。手順書の「失効済みになる」「active として表示されなくなる」は「一覧から消える」として観測した。
- リセットメールの配送は依頼から 10〜40 秒かかることがある（QUEUE consumer の `max_batch_timeout = 30`）。
- TC-41 手順6: 解除後の subject で「Google で続行」するとそのメール（未登録）で新規アカウントが作られる。手順書の期待（このアカウントへはログインできない）は満たすが、テスト用 subject が別アカウントとして残る。
- TC-12 手順3 の最初の試行で controlled input のクリアが効かず `new-user@example.com` / `password123` が登録された（手順書の共有アドレス。他カテゴリは使わない想定）。
- リセット完了画面（P-03 done）の AI クライアント一覧は失効済みの接続を表示しない（「接続はありません」）。リセット完了で直前世代が自動失効するため、完了画面で active な接続が並ぶ状況が作れず、「すべて失効」は常に 0 件に対して押すことになる。0 件でもボタンが出る（手順書の「0 件時に押せる状態を UI が作らない」とは異なる）。手順書 TC-38 手順4 の「一覧の全接続が失効済みになる」は観測不能。
- signup / login の入力欄は `type=email` / `required` / `maxlength` によりブラウザ側で先に弾く。サーバ側の判定は `noValidate` で確認した。
- SSO 連携の「解除」には確認ダイアログが無く即実行される（手順書は「選び、実行する」としか書いていないので合否には影響しない）。

## Implementer の再走（2026-09-11T12:05〜12:36+09:00、HEAD `9bec53e`〜`b7deeb4`、dev :3000）

| TC | 最終判定 | 根拠 |
|---|---|---|
| TC-39 | 合格（ブラウザ + ai-client。「失効済み接続の状態が変わらない」は sqlite 窓で `revoked_at` を追加確認） | 前任の r5 は 2 回目のリセットの結果が未記録のため、新ユーザー `ph10-main-r39@example.com`（session `ph10-r39`、`scratchpad/aic39` = ai-client の複製・loopback 8766）で最初から。前提: リセット完走 12:05:57。手順 1: `R39 Client 1` を認可（12:06）→ P-13 に active。手順 2: パスワード変更「変更しました」後も一覧に残り `call recent_memos` 200（12:06:31）。手順 3: リセット完走（12:22:02）→ 完了画面・P-13 とも「接続はありません」、`call` 401 `invalid_token`、`refresh` 400 `invalid_grant`「The connection is no longer active」。手順 4: `R39 Client 2` を認可（12:22）→ active、`call` 200 → 3 回目のリセット完走（12:36:07）→ `R39 Client 2` の `call` 401、`R39 Client 1` の `refresh` は引き続き 400（状態不変） |

観察: リセット依頼の窓は「前回の依頼から 15 分」ではなく epoch に揃った 15 分の固定窓（`windowKeyOf(hmac, now, windowMs)`、`requestPasswordReset.ts`）。12:21:05 の依頼と 12:35:02 の依頼は別の窓なので 2 通目・3 通目とも届く。spec/usecases/identity.md の窓の定義どおり

### TC-45 / TC-46 / TC-47（Implementer、2026-09-11T12:54〜13:11+09:00。dev 再起動 4 回: R1 = producer binding 無し、R2 = 元に戻す、R3 = `MAIL_DEV_SINK="broken-for-tc46"`、R4 = 元に戻す。設定の変更はコミットしていない。R4 の後 `git status` clean、`.dev.vars` はバックアップと同一）

| TC | 最終判定 | 根拠 |
|---|---|---|
| TC-45 | 合格（**本物の publish 失敗**で実施） | 手順 1: `apps/web/wrangler.state.toml` の `[[queues.producers]]`（`EVENTS_QUEUE`）を一時的にコメントアウトして起動（R1）。新ユーザー `ph10-main-q45@example.com`（`list-bucket-user-ids` の差分で `dir:g1:b0`）。`read-delivery-backlog` = pending 0 → 手順 2: 12:55:21 に依頼 →「登録されていれば…」（`?sent=1`、応答は失敗を含まない）→ 3 秒後 pending 1 → relay の `queue.send` が `TypeError` で失敗し、ログは `Outbox publish failed { eventId, type, cause: 'TypeError' }` のみ（×5、backoff 1 s 基準）→ 手順 3: 約 30 秒で終端。手順 4: `list-quarantined-events` = 1 行、列は `eventId / type / attempt(4) / createdAt / completedAt / terminalReason("TypeError")` の 6 つだけ（`owner_token` / `payload` / `aggregate_id` なし、理由にメール・トークン・userId なし）、backlog は 0（隔離行は数えない）。手順 5: binding を戻して再起動（R2）。手順 6: 12:56:44 `requeue-quarantined-event` → `{ requeued: true }` → 30 秒以内に `[dev-mail] to=ph10-main-q45@…` が届き、リンクから再設定まで完了（依頼から 1 分 23 秒、TTL 1 時間の内側 = 「届く」側の分岐）。停止中の sqlite: 行は `published`、`attempt 0` |
| TC-46 | 合格（手順 6 は Manager の手順書改訂 `acc356f` の期待で再判定） | 手順 1: `.dev.vars` の `MAIL_DEV_SINK` を不正値にして起動（R3）。consumer の組み立てが `ConfigurationError` になり、外部の provider には一切つながない。手順 2: `ph10-main-q46@example.com`（`dir:g1:b1`）で 13:07:08 に依頼 →「登録されていれば…」。手順 3: `Mail consumer is not configured` ×4 → `Moving message … to dead letter queue "tanstack-start-template-events-dlq" after 4 failed attempts`（`max_retries = 3`）→ DLQ handler が 1 回だけの自動再配送を試み（sink が壊れたままなので失敗）、ログは `dlq { eventId, type, outcome: 'failed' }` の 1 行で ack。手順 4: DLQ のメッセージは見ていない（確認ポイントの「写しを残さない」に従い、形は `OutboxQueueMessage` の型 = `eventId / type / payload / routingKey / ownerToken` の 5 項目、payload は `passwordResetRequestedDraft` の `{ tokenId, mailKind }` の 2 つをコードで確認）。手順 5: 停止中の sqlite で発行元 `dir:g1:b1` の当該行は `published`・`attempt 0`・`terminal_reason` 空のまま（`quarantined` ではない）。**手順 6（改訂後: DLQ ハンドラの処理結果）**: DLQ ハンドラは自動で 1 回だけ再配送を試み（sink が壊れたままなので失敗）、`QUEUE tanstack-start-template-events-dlq 1/1` で ack。ログは `dlq { eventId, type, outcome: 'failed' }` の 3 項目だけ（メール・トークンなし）、メールは届かない。`.dev.vars` を戻して再起動（R4 → R5）した後、窓が明けた 13:29:01 に同じアドレスで再依頼 → 27 秒で `[dev-mail] to=ph10-main-q46@…` が届いた（利用者の回復手段 = 再依頼）。自動 1 回の他の結果（`sent` / `nothing-to-send` / `unserved`）は PH-09A の dev 実走と `queueHandlers` の unit が固定 |
| TC-47 | 部分実施（手順 3・4・8・9 の観測）/ 手順 1・2・5〜7 は実行不能 | **bucket 単位で cross-DO RPC を落とす手段が dev に無い**（DO の binding を外すと request 側の経路まで止まる）。代替: `ph10-account-main` の User Data DO（`a9d1e42e…`、userId `01a08d82-da19-…`）の完走済み `resume-link` 2 行を停止中に書き換え — (a) 終端モード（`pending`、`attempt 0`、`completed_at` NULL、`terminal_reason = 'forward-exhausted <operationId>'`）、(b) `poison`（`attempt 5`、`completed_at` あり、`terminal_reason = 'cleanup-exhausted:forward-exhausted <operationId>'`）。再起動後 12:57:30 の `list-poisoned-jobs` は (b) の 1 行だけ（(a) の終端モードは現れない = 手順 3 の確認点）、列は `operationKey / kind / attempt / completedAt / terminalReason` の 5 つで `payload` なし、理由は 6 値トークン + `operationId` だけ（メール・callerToken・世代・bucket 番号なし = 手順 8）。`requeue-poisoned-job (b)` → `{ requeued: true }` → 再武装した Alarm で (a)(b) とも走り、停止中の sqlite（13:06）で両方 `done`・`attempt 0`・`terminal_reason` 残存・`completed_at 12:57:35`（手順 4 / 9 の「後始末から再開して完走、理由は残る」）。対象の link 手続きは `phase = done` なので後始末 L1 は何も消さずに `finished`。後始末が実際に巻き戻す経路と「段が無い行は前進から」の分岐は integration（`recovery.integration` 12 件 / `jobTerminal.integration`、PH-09A で受け入れ）が固定 |

**account.md 最終集計: 合格 46 / 部分実施 1（TC-47）**（全 47。TC-30 は使用済みトークンで期限切れの画面を代替、TC-17 / TC-18 / TC-03 / TC-04 / TC-40 / TC-41 / TC-42 / TC-43 の SSO は `SSO_DEV_STUB` による契約検証）

### TC-38 手順 4 の補強（Implementer、2026-09-11T13:59+09:00、HEAD `7446b5e`）

前任の実走では、リセット完了時点で直前世代の接続が自動失効しており、「すべて失効」を 0 件に対して押していた。`ph10-main-r39@example.com` で 3 回目のリセットの後に `R39 Client 3` を認可（`call` 200）してから `/password-reset/done` を開くと、(b) の一覧に `R39 Client 3 | 接続済み… | 接続を解除` が出る → 「すべて失効」→「失効しました（1 件）」、一覧は「接続はありません。」、`call` は 401 `invalid_token`、P-13 でも「接続はありません。」。**TC-38 は 1 件以上の接続に対しても合格**（「すべて失効」は確認ダイアログを挟まずに実行される。手順書は確認を求めていない）
