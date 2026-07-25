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
| `presentation/errorResponse/kind が transport で落ちる` | R1 | fix | R1 修正中に発覚。SSR と RSC が別 module graph で `instanceof AppServerError` が常に false になり、AC-10 / AC-12 のエラー文言が実行時に一切出ない | 0 |
| `presentation/currentUser/Cache-Control の適用範囲` | R2 | fix | ドキュメント経路のみで server function 経路に付かず manual TC-23 が実際に落ちる | 0 |
| `router/scrollToTopSelectors` | R2 | fix | `main` をスクロールコンテナにした R1 修正の副作用でスクロール位置が持ち越される | 0 |
| `test/ダミーハッシュ陳腐化の検出` | R2 | fix | 対策が死んでも green のままになる | 0 |
| `application/identity/loginWithPassword/ダミーハッシュの結合` | R2 | fix | 反復回数がハードコードで既定値変更に追随しない | 0 |
| `.issue/1/progress.md の陳腐化` | R2 | fix | R1 修正で解決済みの課題が未解決として残っている | 0 |
| `application/types/sessionCodec のユースケース非公開` | R2 | fix | 型エイリアス1本で表現できるので型に落とす | 0 |
| `infra/aws/部分設定検出の空文字誤判定` | R2 | fix | CI の未設定シークレットは空文字になるため現実的 | 0 |
| `adapters/webcrypto/encoding の JSDoc 不正確` | R2 | fix | 実態より広い保証を書いている | 0 |
| `adapters/webcrypto/ガードの無テスト` | R2 | fix | フェイルクローズが「通る側」しか踏まれていない | 0 |
| `CLAUDE.md / docs の todo 参照` | R2 | fix | 削除済みの実装をリファレンスとして名指ししている | 0 |
| `セッション鍵最小長の二重定義` | R2 | fix | ずれるとブランド型を通過した秘密が codec で素の Error を投げる | 0 |
| `ui/AuthSheet/main ランドマーク欠如` | R2 | fix | axe violation 2件 | 0 |
| `ui/TextLink/アクティブ時の className 上書き` | R2 | fix | スタイルとフォーカスリングを喪失 | 0 |
| `layout/AppShell/ブランドリンクの aria-current` | R2 | fix | 現在地が2箇所になる | 0 |
| `routes/_app/canonical` | R2 | fix | `og:url` と矛盾 | 0 |
| `routes/__root/viewport-fit=cover` | R2 | fix | safe-area の修正が常に発火しない | 0 |
| `auth/フォーム全体エラー時のフォーカス` | R2 | fix | フォーカスが body へ落ちる | 0 |
| `.env.example の既定 SESSION_SECRET` | R2 | fix | コピーしてそのまま本番に出ると全アカウントなりすましが成立する | 0 |
| `deferred RSC の throw が middleware を通らない` | R2 | fix | redaction / status / Logger の権威点が保護画面を覆っていない | 0 |
| `test/relay 統合テストの弱い表明` | R2 | fix | R1 W-004 と同種のパターンが4箇所残存 | 0 |
| `test/Cache-Control と無効セッション拒否の無テスト` | R2 | fix | AC-15 / manual TC-23 の根拠が無検証 | 0 |
| `test/errorDisplay の FIELD_LABELS 到達不能` | R2 | fix | R1 で新設した整形がテストから踏まれない | 0 |
| `出荷ソースの ADR 参照が spec/adr と番号衝突` | R3 | fix | `ADR-002` 等が実在する別文書（`spec/adr/002-export-scope.md`）に解決され、007以降は解決しない | 0 |
| `ports/userRepository の JSDoc（ExpectedVersion の発行点）` | R3 | fix | `findByEmail` も鋳造するので記述が偽。R2 が AC-4 の根拠に引用していた | 0 |
| `schema.ts の CHECK 含意コメント` | R3 | fix | 3本中2本で偽（必須制約を「帰結」と書いている） | 0 |
| `burnVerificationTime のログ` | R3 | fix | 静的事実なのに未認証入力で試行ごとに1行出る | 0 |
| `burnVerificationTime が生の例外を logger へ渡す` | R3 | fix | ポート契約が「例外に平文を載せない」を保証していない | 0 |
| `hmacSessionCodec の one-file change JSDoc` | R3 | fix | ADR-036 の単一化で不成立になった | 0 |
| `infra/aws/read() の適用漏れ` | R3 | fix | `CDK_DEFAULT_ACCOUNT` / `REGION` に未適用 | 0 |
| `infra/aws/完全 ARN 正規表現` | R3 | fix | 部分 ARN を通す。`.env.aws.example` の例示値がまさにそれ | 0 |
| `typeof ピンと Omit の退行検出` | R3 | fix | 型注釈1つでピンが無言で死ぬ | 0 |
| `progress.md の spec-sync 節の取りこぼし` | R3 | fix | ADR-008 / 009 / 011 の宣言が漏れている | 0 |
| `routes/_app/errorComponent 欠如` | R3 | fix | streaming リーフの失敗が認証後シェルごと未認証風エラー画面に差し替わる | 0 |
| `シート本文下端の safe-area` | R3 | fix | ノッチ機で実クリアランスが 40px→6px に縮む。ADR-041 の記述も不正確 | 0 |
| `test/送出側 redaction 境界の無テスト` | R3 | fix | AC-10 / AC-12 の文言が依存する経路の退行を検出できない | 0 |
| `plan.md の changePassword ランタイム記述` | R3 | fix | 実装は型のみ | 0 |
| `docs/test.md の Fake policy と存在しないスクリプト` | R3 | fix | 本 PR で fake を追加し同ファイルを編集しているのに未更新 | 0 |
