# 指摘台帳 — Issue #1 / PR #17

照合キーは **Key（ファイル＋シンボル＋問題カテゴリ）**。ID はラウンドごとに振り直されるため、Key が一致する既出指摘は判定を継承し再指摘カウントを +1 する。

判定: `fix`（このスコープで直す）/ `wont-fix`（直さない）/ `defer`（別 Issue で対応）

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `ui/TextField/フォーカスリング` | R1 | fix | Tailwind v4 で `outline-style: none` に解決されキーボード操作が視認できない | 0 |
| `auth/{Login,Signup}Form/送信失敗時の入力保持` | R1 | fix | React 19 の form action 自動リセットで再入力を強いる | 0 |
| `presentation/redirectSearch/テスト欠如` | R1 | fix | オープンリダイレクト防御にテストが1件も無い | 0 |
| `domain/identity/entity/changeTrashRetentionDays の no-op` | R1 | fix | 仕様外の分岐に WHY が無い | 0 |
| `application/identity/getCurrentUser/DTO 形状` | R1 | fix | spec の平坦形に合わせる | 0 |
| `domain/identity/entity/reconstruct のコメント` | R1 | fix | 検出範囲を過大に述べている（誤情報） | 0 |
| `domain/identity/valueObject/長さ検証の単位` | R1 | fix | spec の「文字」に対しコードユニット長で判定している | 0 |
| `application/identity/loginWithPassword/タイミングオラクル` | R1 | fix | ダミー verify で塞げる。同一関数内で完結 | 0 |
| `application/di/secrets/センチネル文字列` | R1 | fix | 不在を `""` で表すのは不正状態を型で排除する原則に反する | 0 |
| `adapters/migrations/0000_initial の内容差し替え` | R1 | fix | ローカル DB の作り直しが必要な旨を docs に記載する | 0 |
| `docs/SESSION_SECRET の記載漏れ` | R1 | fix | Node / CF が未記載、AWS は未設定ステージが黙って消える | 0 |
| `adapters/webcrypto/hmacSessionCodec/keyPromise メモ化` | R1 | fix | JSDoc の主張と実態が食い違う | 0 |
| `adapters/webcrypto/ファクトリ引数の検証` | R1 | fix | 不変条件が DI の1箇所にしかない | 0 |
| `adapters/userRepository/制約の挙動テスト欠如` | R1 | fix | AC-5 がテストで担保されていない | 0 |
| `adapters/webcrypto/pbkdf2/反復回数の上限検査` | R1 | fix | 保存値由来の値で無制限に計算させられる | 0 |
| `application/di/secrets/生 Error の throw` | R1 | fix | redaction 境界の外。起動時検証へ寄せる | 0 |
| `adapters/webcrypto/encoding/JSDoc とテスト欠如` | R1 | fix | 非正規入力の受理が未文書化 | 0 |
| `routes/_app/settings/ストリーミング未使用` | R1 | fix | CLAUDE.md の per-fragment streaming 規約から外れる | 0 |
| `ui/RoutePendingFallback/生値クラス` | R1 | fix | トークン外の生値（AC-18 違反） | 0 |
| `presentation/errorDisplay/transport 検証エラーの表示` | R1 | fix | 英語 zod メッセージと生フィールドキーが出る | 0 |
| `ui/TextField/エラーの live region` | R1 | fix | スクリーンリーダーにエラーが伝わらない | 0 |
| `layout/AppShell/ボトムシートのフォーカス管理` | R1 | fix | 背後要素にフォーカスが抜ける | 0 |
| `layout/AppShell/スクロールモデル` | R1 | fix | PC サイドバーが常設にならず基準形と異なる | 0 |
| `routes/readAuthStateFn の重複` | R1 | fix | 3ルートに逐語コピー | 0 |
| `auth/リンクのクラス重複` | R1 | fix | 6箇所に同じクラス列 | 0 |
| `routes/_app/head 欠如` | R1 | fix | 全画面同一タイトル | 0 |
| `routes/__root/エラー・404 画面` | R1 | fix | 未スタイルでリトライ導線なし | 0 |
| `layout/AppShell/safe-area-inset` | R1 | fix | モバイル下端がホームインジケータに隠れる | 0 |
| `auth/送信中の disabled とフォーカス` | R1 | fix | フォーカスが body に落ちる | 0 |
| `adapters/webcrypto/pbkdf2/rehash-on-login` | R1 | defer | #18。読み取り専用ユースケースに書き込みが入る設計判断を伴う | 0 |
| `auth/レート制限` | R1 | defer | #18。ストアとキー設計の選定が必要で4ランタイム分のポートが要る | 0 |
| `start.ts/CSRF Origin 検証` | R1 | defer | #18。テンプレート全体の設定でスライスと直交 | 0 |
| `認証済みレスポンスの Cache-Control` | R1 | fix | ログアウト後の戻るボタン（manual TC-23）に直結する | 0 |
| `docs/セッション鍵ローテーション手順` | R1 | fix | ステートレス方式の運用上の必須情報 | 0 |
| `infra/aws/CloudFront の Cookie 転送` | R1 | fix | AWS ランタイムでログインが成立しない実バグ | 0 |
| `presentation/redirectSearch/制御文字` | R1 | fix | 多層防御。同一関数内で完結 | 0 |
| `presentation/currentUser/復帰先が _serverFn` | R1 | fix | ログイン後の復帰先が壊れる | 0 |
| `presentation/sessionCookie/__Host- プレフィックス` | R1 | wont-fix | `__Host-` は `Secure` 必須。http のローカル開発と本番で Cookie 名が変わる footgun のほうが大きく、現行の `HttpOnly; Secure; SameSite=Lax; Path=/` に対する上積みが小さい | 0 |
| `test/TC-014 レース経路の固定` | R1 | fix | 両方失敗でも green になる | 0 |
| `test/境界 TC が transport を跨がない` | R1 | fix | spec の「登録される」経路を通っていない | 0 |
| `test/ハッシャー失敗系のトートロジー` | R1 | fix | スタブが投げた値をそのまま見ている | 0 |
| `test/移植した OCC テストの弱い表明` | R1 | fix | `if (!found) return;` で検証がスキップされうる | 0 |
| `test/errorField の無テスト` | R1 | fix | AC-10 / AC-12 を決める純関数 | 0 |
| `test/startSession の無テスト` | R1 | fix | `endSession` のみ検証されている | 0 |
| `test/ハッシュ保存の実ハッシャー検証` | R1 | fix | 平文が保存されないことを実物で見ていない | 0 |
| `test/ALTER TABLE RENAME の巻き込み` | R1 | fix | 失敗するとファイル全体が汚染される | 0 |
