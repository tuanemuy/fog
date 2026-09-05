# fog 全体設計

## 境界

既存 pnpm monorepo と hexagonal architecture を継承する。domain は不変条件と型、application は利用者の操作とトランザクション、adapters は libSQL・暗号・メール・SSO、web presentation は HTTP・セッション cookie・入力形状・RSC・UI を担当する。時計と ID は既存ポートを使う。認証主体は人間と AI を判別可能な union とし、HTTP 入力で主体や所有者を指定させない。

人間の復元・履歴・完全削除を AI 操作から分ける。AI credential は人間用セッションとして利用できない。検索・取得・更新のすべてに所有者境界を適用する。

## 永続化と共有契約

ユーザー、認証手段、セッション、AI 接続、メモとリビジョン、トピック、ドキュメントとリビジョン、出典参照を永続化する。DB に所有者を持ち、参照先も同じ所有者であることをトランザクション内で確認する。集合操作、履歴追加、検索反映、冪等性結果を原子的に確定する。プロセス内メモリや localStorage を製品データの正本にしない。

メモは作成日時を保持する。編集は線形の不変リビジョンを追加し、同内容保存は追加しない。ドキュメント履歴はタイトル・本文・変更理由・主体・時刻を保持する。競合は明示し、人間の確認後の上書きも他の版を残す。AI 部分編集は一致対象と版を検査し、失敗時は何も変えない。

出典はメモ ID を参照する。ソフトデリートは表示用の墓標を残し、ハードデリート時に参照を消す。トピック削除は削除グループを記録し、その操作で削除した文書だけをセット復元する。先に個別削除した文書を勝手に復元しない。孤立したゴミ箱文書は復元先を人間に選ばせる。

人間向け DTO の削除済み出典表示を AI 向けレスポンスに流用しない。AI の文書取得・関連メモ・検索・冪等性再応答からもゴミ箱の本文・タイトル・履歴を除外する。

検索はメモとドキュメントの最新内容を共通 usecase で検索し、削除済みを除外する。完了済みは検索する。トピックスコープは配下文書とその出典メモ。日本語キーワード、投稿直後の検索、安定した追加読み込みを検証する。

## 画面と操作

[画面一覧](../spec/pages/index.md) の P-01〜P-14 と [モック](../spec/design/pages/) を用いる。認証後はデスクトップのサイドバー、スマホのメニューシートを共有する。白いシート、罫線の行、紫の操作色、オレンジのブランド点、OS フォントと既存トークンを使う。

データ取得は async server component と streaming を既定とする。クライアント island は React 19 の pending/optimistic UI を持つ。追加・削除は一覧 owner が管理し、失敗時に入力とエラーを保持する。各 mutation の結果を router.invalidate() で再取得する。削除と完了は別の操作階層に置く。

## 認証と外部接続

パスワードは暗号ポートでハッシュ化し、セッションは推測困難な secret を cookie に載せ DB 側はハッシュを保持する。安全な cookie、同一 origin 検証、相対 return URL、ログイン試行制限を境界で実装する。メールアドレスの自動 SSO リンクは行わない。SSO 追加はログイン中の利用者が開始する。

復旧は期限付き単回 token、同一応答、既存セッション失効、新セッション確立を一つの操作として扱う。完了画面に認証手段と AI 接続の解除導線を同時に出す。リセット以降の AI 接続の失効は S-AC-07 に従う。

AI 認可要求は期限と要求元をサーバーに保持し、認証後に権限一覧を確認して許可・拒否する。HTTP API は許可した操作だけを明示的に列挙し、任意の内部 usecase 名や SQL を実行できない。リトライ用 key と payload の一致を検査し、接続失効を毎回確認する。詳細プロトコルは P4 で固定する。

## 運用

Node の既存起動・マイグレーション・ビルドを再利用する。保持期限 worker は UI のアクセスに依存せず起動する。クラウド保存、バックアップ、復元の再実行手順を残し、ローカルの復元訓練でデータと履歴を確認する。

## 外部契約の参照

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): SSO は Google の主体 ID を保持し、メール一致による自動リンクをしない。state・nonce と token の検証を接続試験に含める。
- [Turso Point-in-Time Recovery](https://docs.turso.tech/features/point-in-time-recovery): クラウド復元手順の参照。実際の保持期間と契約プランは接続する環境で確認する。
- [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) と [RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700): AI クライアントのブラウザ認可には、登録された redirect URI と一回限りの code、PKCE S256 を用いる。長期 credential を URL に含めない。

## SSR 配信の依存修正

TanStack Router の SSR は、未注入 script がある間は配信終了の短絡経路へ入らず、render 終了前に残りを flush する。使用中バージョンに不足する上流修正を最小の pnpm patch として保持する。直接 URL とクライアント遷移の双方で確認し、loader の非同期 streaming と Suspense は維持する。修正前に失敗する回帰テストと適用対象の詳細は [P2 再開報告](phases/P2-resume.md) に記録する。

## P3 データ管理の契約

ソフト削除・復元・完全削除は UoW 内で確定し、トピックと同時に削除した文書を削除グループで識別する。人間用ゴミ箱 DTO は親トピックの状態を示す。通常の文書は所属トピックを必須とし、親が完全削除されたゴミ箱文書は別の型で表現する。既存 DB は migration でこの状態を保持可能にする。

保持期限は既定30日、整数1〜3650日とする。変更は既存のゴミ箱にも適用する。自動削除は clock と UoW を受ける worker 関数にし、Node の起動時と定期処理から呼ぶ。利用者向けサービスに全所有者の期限削除操作を公開しない。

検索は共通 query 契約を使い、メモ・文書の現在の内容へ即反映する。エクスポートは可搬な JSON ファイルとし、所有者の最新メモ・文書・トピック、完了状態、出典の識別子を含める。ゴミ箱と履歴は含めない。JSON形式と保持期限の上限は Manager が補った実装上の仮定。

ソフト削除は認可された人間と AI が共用する。ゴミ箱・復元・完全削除・設定・エクスポートは人間専用とする。

Node の製品配線は fog の保持期限 runner のみを起動する。fog は outbox イベントを発行しないため、未使用の Todo runner は起動しない。これにより起動時の不要な DB 書き込み競合を除く。汎用 worker の参照実装の整理は P5 で行う。

## P4a AI 接続の契約

AI client は起動設定の ID・名前・redirect URI で登録する。動的な外部登録は行わない。`GET /oauth/authorize` は PKCE S256 の要求をサーバーに10分保存し、人間の認可画面へ進む。許可後は登録済み redirect URI へ有効期間2分の単回codeを返し、`POST /oauth/token` で交換する。要求とcodeはclient・redirect・challenge・認可主体へ拘束する。opaque bearer の有効期間は30日、DBはhashのみ保持し、refreshは提供しない。期間と登録方式はManagerが補った実装上の仮定。

AIは `POST /api/ai` の明示したoperationだけを利用する。書込みは接続・冪等性key・正規化payloadを永続台帳に記録し、変更と同じUoWで確定する。replayは再更新せず、現時点の稼働中projectionまたは安全な完了receiptを返す。過去本文をキャッシュせず、削除された対象・出典のmetadataを返さない。毎回接続失効を検査する。

人間用cookie経路はAI bearerと混用せず、Authorization付きの呼び出しを拒否する。信頼済みredirectの検証前に外部へ遷移しない。認可の許可・拒否と接続失効は人間のOrigin/CSRF境界を通す。

## P4b アカウント接続の契約

Google は固定した公式 endpoint と JOSE の署名・issuer・audience・nonce 検査を用いる。state・PKCE・browser binding cookie を持つ10分の単回要求をDBに保存する。明示SSO連携は開始時の人間とcallback時の現session主体を照合し、既存sessionを維持する。

ローカル検証は明示した OIDC fixture と SMTP mailbox を使い、APP_URL・issuer・callback・listener をloopbackへ限定する。本Google設定と分離し、外部公開URLからfixtureを利用しない。既存 `.env` にGoogle/OAuth/OIDC/SMTP/mail設定キーがないことを確認済み。値は出力せず保持する。

リセットtokenは有効30分、hashのみを保持して単回消費する。依頼は15分枠で3回までとし、未登録・SSOのみ・制限中・配送失敗を含め同じ応答を返す。メールpassword手段を持つ対象だけに送る。期間と回数はManagerが補った実装上の仮定。

リセット完了はpassword更新・全旧session失効・新session作成・前回リセット以降のAI接続失効を同一UoWで確定する。完了画面にログイン手段とAI接続を並べ、SSO解除とAIのすべて失効を提供する。

通常のpassword変更も、現在passwordの確認後に全sessionを失効して新sessionへ交換する。メール依頼はtoken作成と配送outboxを同じUoWに保存し、5秒周期のworkerがlease・retry付きでSMTPへ配送する。要求応答は配送成否から分離する。token照合はhashのみ、配送URLを含む短期payloadは送信成功・期限切れ・reset消費時に消去し、ログへ出さない。

## P5 実行と復元の契約

製品runtimeをNodeに統一し、未使用の他runtime・infra・Todo専用配線を除く。fog UoWと共有clock/ID/logger/error等の必要な契約は保持する。既存DBの旧tableは削除せず、新規初期化はfogだけを作る。NodeからクラウドlibSQLへ接続するURL/auth配線を保持する。

ローカルbackupはSQLiteのVACUUM INTOで稼働中の一貫snapshotを作り、integrity/FK検査とSHA-256 manifestを保存する。artifact directoryは0700、fileは0600。保持削除は自分の既知patternだけを対象にする。cloud snapshot/PITRの手順はlocal backupと区別する。

restoreは新しいpathだけを受け付ける。既定で全ownerのsession・AI接続・pending OAuth/reset/mailを失効し、隔離検証の明示 `--preserve-access` は完全一致復元に使う。復元時点のpassword/SSOも戻るため、再公開前に認証手段を確認する運用手順を残す。外部uploadと公開は行わない。

実Googleの検証は、登録した `http://localhost:3000/auth/google/callback` でも行える。公開HTTPS URLをローカル検証の必須条件にはしない。
