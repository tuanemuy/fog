# P4b ローカル実装完了候補

R19/R20 の実装と実行可能なローカル契約検証を完了した。独立 Verifier の受け入れ前の候補である。実 Google と外部 SMTP の認証・配送は未検証であり、R19/R20 の実サービスを含む全完了を宣言しない。P5 は開始していない。

## 要件対応

| ID | 実装とローカル根拠 | 外部の残条件 |
| --- | --- | --- |
| R19 | Google 初回/再ログイン、取消/失敗、明示連携、subject/primary email 両一意、自動連携拒否、session 維持、最後の手段保護、メール手段解除不可。state/browser/actor/S256/nonce/RS256/issuer/audience/azp/期限を検査。実 HTTP OIDC fixture・JOSE 署名交換・ブラウザ・実 DB で確認。 | 実 client 登録、redirect 設定、実 Google 同意画面と成功/取消/失敗の確認。 |
| R20 | 現在 password 必須の通常変更と全 human session 交換、SSO-only への変更フォーム非表示、同一応答の復旧依頼、30分単回 token、outbox、全 session 失効+新 session の原子処理、前回 reset 以降の AI 自動失効、完了画面で credential/AI 一覧と Google 解除・AI 全失効。実 SMTP mailbox→ブラウザ reset→旧 session/AI 拒否を確認。 | 許可された実 SMTP の認証、送信元・受信先での配送とメール到達性確認。 |

## 契約と実装

- `accountPorts.ts` / `accountTypes.ts` に Google identity、reset mailer、credential DTO、人間用操作を定義した。DB・時計・ID・暗号・外部交換は port 境界に置く。core 詳細と75件の実 DB 根拠は `P4b-core.md`。
- Google の接続先は公式 endpoint 固定。fixture origin は別設定で HTTP loopback の issuer と APP_URL を要求する。メール fixture も SMTP host と APP_URL を loopback に制限し、listener は `127.0.0.1` に bind する。外部 APP_URL からの fixture 設定を adapter/config 試験で拒否した。
- Google 要求は10分。browser cookie の hash、state hash、owner/mode、nonce、PKCE、保存 returnTo に拘束する。外部 token 交換の前後に要求を再検査する。成功と取消は単回。リンク時の既存 session は維持する。
- callback は cookie 設定・同一アプリへの redirect だけを担当する。追加の Google callback パラメータは無視し、重複 query・code/error 同時指定・欠落 state は拒否する。Authorization 付き callback は403。no-store/no-referrer を付ける。
- Google 既存 credential の業務エラーは「既に連携されています」と表示する。対応コードの回帰試験を追加し、最終 dev 再起動後のブラウザで確認した。
- 通常 password 変更は全 human session を終了して新 session を同じ UoW で発行する。既存 AI 接続は維持する。pending reset token/mail・AI grant・Google link state を無効化する。現在 password の不一致は具体的なエラーを表示する。
- reset 依頼は3回/15分、token は30分。依頼本文は password user・未登録・SSO-only・制限中で同一であり、配送は HTTP 依頼から分離する。検索用 token は hash のみ。URL を含む outbox は短期秘密データとして扱い、送信成功・期限切れ・reset 消費・password 変更で消去する。
- reset worker は5秒周期、60秒 lease、安定 message ID、backoff、at-least-once 配送。重複実行を防ぎ、停止は実行中処理を drain する。mailer 未設定でも期限切れ秘密データを掃除する。ログには token/cookie/URL/provider credential を出さない。
- reset 完了は password 更新、旧全 session 失効、新 session 作成、token/mail 消去、reset 時刻、AI cutoff 失効を同一 UoW で確定する。初回は account 作成以降、以後は前回 reset 時刻以上の接続が対象。それより古い接続は残す。AI 全失効は pending grant も破棄する。
- credential と AI 接続の list owner が `useOptimistic` / `useTransition` を持つ。form は `useActionState` と pending/error を持ち、mutation 後は router invalidate で同期する。設定・復旧完了は server component の stream を維持する。
- `docs/account_access.md` に環境変数・fixture 起動・操作手順・外部再開条件を記録した。既存 `apps/web/.env` は保持し、関連キーの存在だけを確認した。Google/SMTP の既存設定はなかった。

実装の一次資料: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)、[jose JWT verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)、[Nodemailer SMTP](https://nodemailer.com/smtp)。

## 検証

| チェック | 最終結果 | 根拠 |
| --- | --- | --- |
| root typecheck | 成功 | `P4b-evidence/typecheck.log` |
| root lint:fix / format | 成功、既存21件の info のみ | `lint.log` / `format.log` |
| unit | 19 files / 131 tests 成功、21:53:10 JST | `unit.log` |
| Node integration | 11 files / 105 tests 成功 | `node-integration.log` |
| integration 一式 | Node105 / CF70 成功 | `integration.log`。CF 終了時の既存 WebSocket disconnect log あり。 |
| production build | 成功 | `build.log` |
| callback 最終回帰 | 9 tests 成功 | `callback.log` |
| production worker | HTTP0回、queue1→0、SMTP配送、SIGTERM drain exit0 | `production-worker.json`、2026-09-05T12:49:56.842Z |

unit の新規契約試験は concrete OIDC の正常単回交換、誤署名/issuer/audience/nonce/期限/メール未確認/PKCE 拒否、実 loopback SMTP 受信、fixture の外部設定拒否、callback と worker lifecycle を含む。core21件は並行・rollback・境界時計・lease/retry・期限切れ未送信・token/mail 消去・前回 reset cutoff・migration 保持を実 DB で検査した。

`.goal-implement/**` の専用証跡 harness は通常 unit 探索から除外した既存 P4a 方針を維持している。製品の test 対象は減らしていない。P4b の具体 adapter/HTTP/worker テストは通常 unit、実 DB は Node integration に含まれる。

ブラウザ session `fog-p4b` で確認した:

- OIDC fixture→初回 SSO→timeline、logout→同じ subject で再ログイン。SSO-only 設定に password form なし、最後の Google 解除 disabled。
- Google 取消/失敗、既存 password email の初回 SSO 拒否と説明。ログイン済み owner への明示 Google link は前後 cookie が一致。他 owner の既存 subject は説明付きで拒否。
- 通常変更で誤った現在 password を拒否、正しい入力で変更。cookie は新値、旧 cookie で settings は307→login。
- 復旧依頼の画面の一律応答。SMTP mailbox に実受信したメールからリンクをクリックし reset 成功。使用済みリンクの再送信は無効と表示。
- reset 前の AI client は401、旧 human session は307→login、新 session は完了画面へ。完了画面で credential と AI の両セクションを同時に取得。
- 完了画面の Google 解除で credential が消える。再認可した実 AI client を完了画面の「すべて解除」で失効し、API401を確認。
- PC および390px mobile の完了画面を確認。mobile の document scrollWidth=innerWidth=390、両セクションあり。画像は `P4b-evidence/*.png`。

`P4b-boundary.mjs` は HTTP 上で全6 account mutation の Bearer/異 Origin 拒否、Origin 欠落拒否、通常変更後旧 session 拒否、登録/未登録/SSO-only/制限中の応答本文の完全一致を確認した。`boundary.json` に実時刻と結果を保存し、秘密値は保存していない。`reset-rotation.json` は reset 後の session rotation と API401の実測。

## 再開とローカル fixture

- dev は `localhost:3000`、Vite PID **5465**、exec **76768**。最終 source で21:52台に再起動した。設定は `docs/account_access.md` の local OIDC/SMTP に、既存 `FOG_AI_CLIENTS` の `fog-local-client` を追加したもの。
- provider/SMTP/mailbox は PID **2466**、exec **43141**。`127.0.0.1:3457` / `:1025` / `:8025`。全てローカル。実 Google・外部メールへ接続していない。
- browser `fog-p4b` は close 済み。AI callback3456・production3002・unit fixture3467/1035/8035は停止済み。
- owner fixture: `p4-owner-20260905@example.test`。新 password は `p4b-reset-password-2026`。旧 P4a password と通常変更時 password は無効。Google は完了画面で解除済み、AI 接続はすべて失効済み。メモ・文書・履歴は P4a/P3 の状態を保持する。
- SSO-only fixture: email `sso-p4b@example.test`、subject `p4b-google-subject`。password なし、Google が最後の手段。provider の正常モードで同 subject を入力してログインできる。
- mailbox は consumed reset3件と別の production worker fixture 宛1件をメモリ内に持つ。既存の3件は無効。新しい復旧を依頼して試す。メールに含まれる秘密 URL はコピーして報告しない。
- token/cookie の一時ファイルはローカル `/tmp` のみ。AI token file は失効済み。Verifier は自身の browser session と再認可を使う。
- 実 Google 検証の再開には client ID/secret、登録 redirect、許可された実アカウントが必要。実メールは SMTP 設定、送信元・受信先、外部送信の明示許可が必要。設定未回答を理由に残したローカル実装はない。

## 固定対象と停止

HEAD は `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。対象は `.goal-implement` を除く未コミット177 paths。削除は sha256=null。`P4b-target-hashes.json` の記録時刻は **2026-09-05T21:54:45.355208+09:00**、manifest SHA256 は **6d2b59efbf7f7b42b0b9d0a24d853f59a28b243f4df2541b490f5b725147ffc0**。

実装・DB seed・browser・通常検証の書き込みを停止した。この報告の保存後は独立 Verifier または Manager の具体的修正依頼を待つ。Manager 台帳と全体 goal は変更していない。独立検証を本報告で自己代替しない。
