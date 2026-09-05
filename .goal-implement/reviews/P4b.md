# P4b 独立検証

判定: **R19 / R20 local PASS、実 Google・外部 SMTP は未検証**。ローカル受入を阻害する製品不具合は検出しなかった。実サービスを含む全要件の完了判定ではない。

検証者: Manager 直轄 Verifier `/root/verifier`。2026-09-05T22:25:00+09:00〜2026-09-05T22:39:08+09:00。実装への参加なし。コードと Manager 管理文書は変更せず、独立報告・証拠のみ保存した。ブラウザとローカル HTTP/SMTP は本担当が専有した。

## 対象と既存根拠

正本は `spec/requirements.md` §5.2、`spec/scenario/account.md` S-AC-02 / S-AC-07、`.goal-implement/{brief,design,plan}.md`。実装報告 `phases/P4b.md` と `phases/P4b-core.md` を照合した。

HEAD `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。`phases/P4b-target-hashes.json` の177対象（削除対象を含む）は開始時と終了時に全一致。manifest SHA-256 は `6d2b59efbf7f7b42b0b9d0a24d853f59a28b243f4df2541b490f5b725147ffc0`。[終了時記録](P4b-hash-check.json)。開始時の dev PID 5465 / localhost:3000、fixture PID 2466 / 3457・1025・8025 は申告どおりだった。

候補に記録された unit131 / Node105 / CF70、typecheck / lint / format / build 成功は対象一致の範囲で適用可能。全件は反復しなかった。[core 独立報告](P4b-core.md) の既存75件・独立5件 PASS を参照する。並行変更・reset交換中競合・全状態rollback・lease・AI cutoff は同報告の独立範囲。

## 要件別結果

| ID | 判定 | 独立根拠 |
| --- | --- | --- |
| R19 SSO 初回 / 再ログイン | local PASS | 新規 `sso-p4b-review@example.test` / subject `p4b-review-subject` で provider→RS256 JWT交換→初回 timeline。logout 後に同主体で再ログインし timeline。SSOのみ設定に password変更欄なし、最後の Google解除は disabled。 |
| R19 中断 / 認証失敗 | local PASS | provider のキャンセルで login に「認証を中断」、認証失敗で login に再試行案内。未認証状態を維持した。署名・issuer・audience・nonce・期限・確認済みemailの不正は concrete adapter の独立 focused tests で拒否を確認。 |
| R19 一意性 / 明示連携 | local PASS | password owner のメールで新subjectの初回SSOは拒否され、password login→設定への案内。owner設定で新subjectを明示linkし成功、前後の fog_session 値を非出力で比較して同一。別ownerに属する上記 review subject のlinkは既存連携エラー。password手段には解除ボタンなし。 |
| R19 解除 / HTTP | local PASS | reset完了画面の Google一覧から確認dialog→解除し一覧が更新。callback の Bearer拒否・重複query・安全な returnTo・secure session cookie・link時session維持は focused tests。全account mutations の Bearer / cross-origin 拒否を実HTTPで独立再実行。 |
| R20 通常 password変更 | local PASS | 誤った current password は専用エラー。正しいcurrentで変更中 disabled/pending→成功。session値が変化し旧cookieの /settings は307 login、既存AI guidanceは200で維持。エラー後はフォーム値がクリアされるので両入力を再入力して成功した。 |
| R20 同一復旧応答 | local PASS | 未登録・SSOのみ・password owner・短時間反復を実HTTPで発行し、全200かつ応答本文がbyte同一。6 mutations のBearer/cross-Origin、Originなし拒否と合わせて [21観測](P4b-boundary.json)。 |
| R20 SMTP→reset→失効 | local PASS | 新規依頼のメール5を localhost SMTP受信箱で確認し、実リンクをブラウザで開いて新password設定。処理中disabled表示後、自動でログイン済みreset完了画面。直前cookieは307 login、直前に作成したAI credentialのread/writeは401。使用済みメール5で再設定を試すと無効/期限切れ表示と再送導線。期限境界・単回競合・古いAI保持は core独立試験を参照。 |
| R20 復旧完了の同一画面 | local PASS | Google一覧/解除とAI一覧/全解除、timelineへの導線が同一画面。PCでGoogle解除を実行。復旧後に新AI接続を作成し、mobileの同画面で一覧→全解除確認→実行、当該AI guidance401。 |
| R20 worker / 秘密 | local PASS | 実SMTP配送をブラウザで独立確認。Node bootで mail runner開始、5秒周期・多重tick抑制・stopのin-flight drain・例外内容非ログをコードとfocused testsで確認。候補の [production無HTTP配送証拠](../phases/P4b-evidence/production-worker.json) は同一対象に適用可能: HTTP0、queued1→0、SMTP到達、SIGTERM drain exit0。 |
| R19 実 Google | 未検証 | local OIDC は実Google client登録、同意画面、provider運用設定を代替しない。 |
| R20 外部 SMTP | 未検証 | local SMTP は実SMTP認証/TLS接続、許可送信元、配送到達性・迷惑メール分類を代替しない。 |

## 具体 adapter と画面

`googleIdentity.ts` は production endpoint固定、RS256・issuer・audience・azp・nonce・email_verified・iat/expを検査し、token/JWKS通信のtimeoutとredirect拒否を設定する。fixtureはHTTP loopback appでのみ有効。`smtpMailer.ts` は外部465のTLS / その他STARTTLS必須、local例外をloopback app/hostに限定し、URL origin/pathと送信元改行を検査する。file/URL access、debug/logを無効にし、provider・SMTP例外を秘密のないアプリケーションエラーへ変換する。`fogAccountConfig.ts` の片側credential不備や危険なfixture配線の起動拒否を確認した。

2026-09-05T22:30:30+09:00、`pnpm exec vitest run apps/web/app/presentation/fogAccountProviders.test.ts apps/web/app/presentation/fogGoogleHttp.test.ts apps/web/app/worker/node/fogResetMailRunner.test.ts` は **3 files / 22 tests PASS**。本物のローカルHTTP、JOSE署名検証、SMTP受信を含む。[HTTP独立harness](P4b-boundary.mjs) は候補を複製して新cookieと独立出力先で実行し、製品や候補証拠は変更していない。

[PC 1440×1000](P4b-reset-complete-pc.png)、[mobile 390×844](P4b-reset-complete-mobile.png) を画像で確認した。完了説明、認証手段、AI接続、解除ボタン、timelineリンクが読め、mobileで解除操作ができる。横overflowなし。password変更・resetのpending、wrong current・使用済みtokenのerrorをブラウザ確認した。確認dialogの操作と一覧更新も成功した。

## 外部検証の再開条件

R19: 使用を許可された実 Google Web client ID/secret、登録済み `${APP_URL}/auth/google/callback`、公開HTTPS URL、同意画面のテスト対象アカウントと実行許可。fixtureを外し、初回/再login/中断/明示link/解除を実Googleで確認する。

R20: 許可された実 SMTP host/port/credentials・送信元/受信先と外部送信の明示許可、公開HTTPS APP_URL。FOG_SMTP_LOCALを外し、TLS認証・配送到達・新規リンク単回reset・旧session/AI失効を確認する。外部送信は今回の brief の実行範囲外であり、本検証では行っていない。

## 引継ぎと停止

owner `p4-owner-20260905@example.test` の現在passwordは local fixture用 `p4b-review-reset-password-2026`。独立検証で追加したowner Google連携と2つのAI接続はすべて解除済み。既存メモ等は変更していない。SSO-only review fixtureは上記email/subjectで再使用可能。

同一応答試験で追加依頼が生じたため、最後に同じ現passwordへの通常変更を成功させ、未使用reset token/mailと古いhuman sessionを無効化した。メール受信箱には無効な過去リンクが残るため、次回も必ず新依頼を使う。private cookie/tokenファイルは /tmp/fog-p4br-*、mode0600で、報告へcredential値は転記していない。AI tokenは双方失効済み。

2026-09-05T22:39:08+09:00、browser `fog-p4b-review` とAI callback CLIをclose、3456 listenerなし。dev PID5465 / exec76768 と account fixture PID2466 / exec43141 は停止せず引継ぎ。ログは各exec sessionのpollで閲覧できる。再起動は `docs/account_access.md` のlocal手順を使い、AI検証が必要なら既存 FOG_AI_CLIENTS 設定も付ける。本担当の検証操作と書込みを終了する。
