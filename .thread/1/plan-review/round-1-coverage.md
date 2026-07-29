# レビュー round-1 — 要件カバレッジ・スコープ整合性（Issue #1）

対象: `.thread/1/plan.md` / `.thread/1/adr.md`
視点: Issue の実装チェックリスト75行のカバレッジ、ID と spec 実体の一致、受け入れ基準の検証可能性、スコープ整合性

## 突き合わせの方法（前提）

1. Issue 本文の `- [ ]` 行から ID を機械抽出（75件）
2. plan.md「チェックリスト対応表」の表頭 ID を機械抽出（75件）
3. 両者を `diff` → **完全一致・重複なし**（欠落0 / 余剰0）
4. 上記のうち代表 ID について `spec/inventory/{domain,adapter,usecase,frontend,test}.md` の「実装されるべき振る舞いの要点」とリンク先 spec 節（`spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/database/index.md#users` / `spec/pages/index.md` / `spec/testcases/identity/*.md`）を読み、計画の記述が要点を実際に満たすか個別照合
5. 既存コード（`adapters/d1/schema.ts` / `repositories/helpers.ts` / `libsql/unitOfWork.ts` / `presentation/errorResponse.ts` / `presentation/errorDisplay.ts` / vitest 3 configs / package.json scripts）で、計画が前提にしている事実を検証

**Issue のコメント欄は 0 件**（`gh issue view 1 --json comments` で確認）。したがって計画とコメントでの合意事項の矛盾は存在しない。

## 問題点（要修正）

- **[P-001]** AC-6 の記述が設計本文・実装ステップ10と矛盾しており、ADP-identity-001 が「見せかけのカバー」になりかけている
  - 理由: AC-6 は「`UserRepository` の実装が…email 一意制約違反を `ConflictError("EMAIL_ALREADY_REGISTERED")`…に翻訳する（ADP-identity-001〜004）」と書いているが、「アダプター / 永続化」節とステップ10は「UoW 方式では違反が flush 時に出るためリポジトリ内では捕捉できない → `registerWithPassword` ユースケース側で `UNIQUE_VIOLATION` を読み替える」としている。技術的判断そのものは正しい（`adapters/libsql/unitOfWork.ts` は `PendingBatch` へ積んで `db.transaction` 内で一括 flush、d1 も同様であることを確認済み）が、**受け入れ基準がその判断と逆のことを述べている**。この状態だと実装者は AC-6 を満たすためにリポジトリ内で捕捉を試み、レビュアは AC-6 を根拠に「翻訳がリポジトリに無い」と指摘する。さらに `spec/inventory/adapter.md` の ADP-identity-001 の要点は「insert が翻訳する」であり、計画はレイヤーを変えて満たすことになるため、その差分が ADR に残っていない（ADR-001〜007 のどこにも無い）
  - 提案: (a) AC-6 を「email 一意制約違反は `ConflictError("EMAIL_ALREADY_REGISTERED")` として**ユースケース境界で**返る（翻訳点はアダプターではなく `registerWithPassword`）」と実態に合わせて書き換える。(b) この翻訳点の移動を **ADR-008** として adr.md に切り出す（Context: 遅延バッチ UoW では制約違反が flush 時に出る／Decision: ユースケース境界で `UNIQUE_VIOLATION` → `EMAIL_ALREADY_REGISTERED`／Consequences: ADP-identity-001 の記述と実装レイヤーが食い違うので spec-sync 対象）。(c) 併せて ADP-identity-001 の要点に含まれる `SSO_IDENTITY_ALREADY_REGISTERED` の翻訳が本スライスでは到達不能（SSO 登録ユースケースが無い）である旨を「スコープ / 含まれないもの」に一行で明示する。現状は言及がなく、ID だけ表に載って中身の一部が欠ける形になっている

- **[P-002]** PAGE-signup-002 の「送信中表示あり」が受け入れ基準にもステップにも落ちていない
  - 理由: `spec/inventory/frontend.md` の PAGE-signup-002 の要点は「成功でタイムラインへ遷移。登録済みメールは重複エラーとログインへの導線を表示。**送信中表示あり**」。AC-10（login）には「送信中はボタン無効＋進行表示」が入っているが、AC-12（signup）には無く、ステップ17の変更内容にも pending UI の記述が無い。CLAUDE.md も「optimistic/pending UI の無いフォームは既定の失敗モード」と明記している。さらに `spec/manual-tests/account.md` TC-15（登録ボタン連打で二重登録されない＝送信中のボタン無効化の検証）が、ステップ23の手動確認リスト（TC-01/02/05/06/12/13/14/16/19/20/22/23）から漏れている
  - 提案: AC-12 の末尾に「送信中はボタン無効＋進行表示となり、連打しても登録は1回だけ実行される（PAGE-signup-002 / manual TC-15）」を追加し、ステップ17の変更内容に `useActionState` の `isPending` によるボタン無効化を明記。ステップ23の手動確認リストに TC-15 を追加する

- **[P-003]** TC-logout-003 の検証手段が実装ステップに存在しない（テスト表だけが先行している）
  - 理由: `spec/inventory/test.md` の TC-logout-003 は「アダプター層で `SystemError` として扱われれば PASS」。plan のテスト表は「単体（`endSession` 内の throw が `SystemError` になること）」としているが、ステップ13（`session.ts` / `currentUser.ts`）の変更内容には `SystemError` へのラップが一切書かれておらず、ステップ22のテストファイル一覧にある `session.test.ts` の内容も「`buildSessionCookie` の属性」だけ（TC-logout-002 相当）。実装を確認したところ、`apps/web/app/presentation/errorResponse.ts` の `serializeError` は `isSerializableError` でない throw を `kind: "unknown"` にするため、**素の例外を投げても `SystemError` にはならない**。「UI / プレゼンテーション」節の「セッション破棄で throw した場合は `SystemError` として上がる（TC-logout-003）」という記述は現状の実装では成立しない
  - 提案: ステップ13の変更内容に「`endSession` / `startSession` の Cookie 書き込み失敗は `SystemError(SystemErrorCode.*)` に包んで throw する」を明記し、ステップ22の `session.test.ts` に「破棄処理が失敗したとき `SystemError` になる」ケース（Cookie 書き込み API をスタブで throw させる）を追加する。もしくは TC-logout-003 を「手動のみで確認」に落とすなら、その旨と根拠をテスト表に書く（現状は自動で確認できると読める）

- **[P-004]** 「弱パスワード / メール形式不正」のユーザー向け表示文言が未定義で、Issue の「検証」節を満たせない可能性がある
  - 理由: Issue の検証節は「重複メール・**弱パスワード**のエラー表示」を要求し、AC-12 も「メール形式不正・パスワード要件未満は項目ごとに表示」としている。しかしこれらは `BusinessRuleError(IDENTITY_INVALID_EMAIL / IDENTITY_PASSWORD_TOO_WEAK)` として上がり、`apps/web/app/presentation/errorDisplay.ts` の `business` 分岐は `return error.message`、すなわち**ドメインが throw した英語メッセージ**（テンプレートの規約は `"Invalid todo id"` 等）をそのまま画面に出す。ステップ16 / 17 が errorDisplay に追加すると書いているのは `INVALID_CREDENTIALS` と `EMAIL_ALREADY_REGISTERED` の2つだけで、business 系2コードの文言は計画に無い。加えて `validation` 分岐は `fieldErrors` が無いと `error.message` を返す実装なので、`INVALID_CREDENTIALS` も「文言を追加」だけでは効かず **code ベースの分岐追加**（`renderConflictMessage` と同じ形）が必要
  - 提案: ステップ16 / 17 の変更内容を「`errorDisplay.ts` に `renderValidationMessage(code)` / `renderBusinessMessage(code)` 相当の code 分岐を追加し、`INVALID_CREDENTIALS`＝「メールアドレスまたはパスワードが正しくありません」、`EMAIL_ALREADY_REGISTERED`＝「このメールアドレスは登録済みです」、`IDENTITY_PASSWORD_TOO_WEAK`＝「パスワードは8文字以上128文字以下で入力してください」、`IDENTITY_INVALID_EMAIL`＝「メールアドレスの形式が正しくありません」を割り当てる」と具体化する

## 改善提案（検討推奨）

- **[S-001]** Issue 本文の「対象シナリオ」のシナリオ ID ずれを plan に注記する
  - 理由: Issue は「spec/scenario/account.md#ログイン / ログアウト（**S-AC-02**）」と書いているが、`spec/scenario/account.md` の実体は S-AC-02＝**SSO** による登録・ログイン、S-AC-03＝ログイン（パスワード）、S-AC-04＝ログアウト。plan は AC-9 / AC-15 で正しく S-AC-03 / S-AC-04 を参照し、スコープ節でも S-AC-02 を SSO として除外しており**解釈は正しい**。ただしその読み替えが plan のどこにも明記されていないため、Issue 本文だけを見た実装者が S-AC-02（SSO）をスコープ内と誤読する余地が残る。「Issue 本文の S-AC-02 表記は S-AC-03 / S-AC-04 の誤り。SSO の S-AC-02 はスコープ外」と一行入れておくと事故が消える

- **[S-002]** `buildSessionCookie` を `session.ts` とは別ファイルに切り出す
  - 理由: plan は TC-logout-002 を `apps/web/app/presentation/__tests__/session.test.ts` の単体テストで担保する設計だが、`session.ts` の先頭には `import "@tanstack/react-start/server-only";` が入る予定。root の `vitest.config.ts`（node pool・include はデフォルト）は `apps/web` 配下も拾うため、server-only モジュールの読み込みが失敗すると TC-logout-002 の唯一の自動検証手段が落ちる。`sessionCookie.ts`（純関数のみ・server-only import なし）に分け、`session.ts` がそれを使う形にすればリスクがゼロになる

- **[S-003]** PBKDF2 の反復回数をファクトリ引数にする（既定 210,000 のまま）
  - 理由: ADR-003 は「反復回数は環境変数化せず定数」としているが、統合テスト（Miniflare D1 プール）では `registerWithPassword` / `loginWithPassword` 系が十数ケース走り、そのすべてが 210k 回の PBKDF2 を実行する。Workers プールは CPU 予算が厳しく、テスト時間・タイムアウトのリスクが AC-16 / AC-17 に直撃する。「環境変数では変えない（強度が環境で揺れない）」という ADR の意図は保ったまま、`createPbkdf2PasswordHasher({ iterations = 210_000 })` としてテストからのみ低い値を渡す（またはユースケース統合テストではフェイクハッシャーを注入し、実アルゴリズムは `adapters/webcrypto/__tests__` で担保する）方針をリスク節に追記したい

- **[S-004]** チェックリスト外だが付随実装される ID を対応表に「付随」行として明記する
  - 理由: 計画は DOM-identity-001 / 011 / TC-getCurrentUser-002 の要求から、チェックリストに無い **DOM-identity-004（AiClientConnectionId）/ 008（SsoProvider）/ 009（ClientName）/ 014（passwordChanged イベント）/ 015（trashRetentionChanged イベント）** を実装する（スコープ節で理由は説明済み）。これらは後続スライスの Issue のチェックリストに載るはずなので、対応表に「付随実装（本 Issue のチェックリスト外・後続 Issue で再実装しない）」の行を足しておくと、後続 Issue での二重作業と「未実装と誤認しての作り直し」を防げる

- **[S-005]** `auth/schema.ts` のパスワード上限 128 は、ドメインの上限と同値にしない方が spec の意図に沿う
  - 理由: 計画は「最低長8は transport に書かない（`PasswordTooWeak`＝business を返すため）」と正しく判断しているが、上限は 128 と書く設計になっており、129文字入力時は transport の `validation` になり `PasswordTooWeak`（business）にならない。境界の判定をドメイン一箇所に寄せるという同じ理屈なら、DoS 目的の上限は明確に大きい値（例: 1024）にして、128 の判定は `PlainPassword` に一本化するのが一貫する（TC-registerWithPassword-009 はユースケース直呼びなので自動テストは通るが、UI 上のエラー種別だけが仕様と食い違う）

- **[S-006]** 読み取り専用ユースケースを `unitOfWorkProvider.run` 経由にする判断を記録に残す
  - 理由: `spec/usecases/identity.md` は `loginWithPassword` を「読み取りのみ。UoW 不要」と明記しており、計画は「`UnitOfWorkContext` からしかリポジトリを取れない構造なので純読み取り UoW で満たす」と実装上の必然から判断している（`libsql/unitOfWork.ts` に「Pure-read UoW: skip the transaction.」があり事実として正しい）。判断は妥当だが spec の字面とは差が出るため、ADR に1本足すか「spec-sync 対象」としてリスク節に残しておくと、後で「spec 違反」と誤検出されない

## 良い点

- **チェックリスト75行のカバレッジは機械的に完全**。Issue 側の ID 集合と plan の対応表の ID 集合を `diff` した結果が完全一致（欠落0・余剰0・重複0）。「75/75。未カバーなし」の自己申告が検証で裏付けられた
- **ID → 受け入れ基準 → 実装ステップ → テスト種別の四重の対応**が張られており、特に TC 39件が1件ずつ「単体 / property / 統合 / 手動」と実装先ファイルまで割り付けられている。TC-loginWithPassword-008（失敗応答の同一性）を「003〜007 の `kind` / `code` / `message` が完全一致することを表明する」と検証可能な形に落としているのは、spec の意図（原因を明かさない）を最も正確に翻訳している
- **inventory の「要点」と計画の中身が概ね一致している**（サンプル照合で確認）: `users_sso_identity_uq` の部分一意インデックス・直和 CHECK1本（ADP-users-001 / `spec/database/index.md#users` と一致）、再水和不整合行の `SystemError(DataIntegrityError)`（ADP-identity-003）、`CurrentUserView` が `passwordHash` / SSO 主体 ID を含まない（UC-identity-013 / TC-getCurrentUser-003・004）、`registerWithPassword` の「UoW 外 hash → UoW 内 findByEmail 事前検証 → insert → collectEvents」（UC-identity-001 の処理フローと逐語的に一致）
- **ADP-outbox-001 / processed-events-001 / occ-guard-001 を「既存実装で満たす」とした判断が事実で裏付けられる**。`adapters/d1/schema.ts` に `outbox_events`（`idx_outbox_pending` の部分インデックス付き）・`processed_events`・`_occ_guard` が実在することを確認した。名称差（`outbox` vs `outbox_events`）を「spec 側の記述揺れなので実装を変えない」と判断したのも spec/database の「テンプレート流儀に従い再定義しない」と整合する
- **スコープ外の宣言が明示的かつ根拠付き**。SSO / パスワードリセット本体 / AiClientConnection・OAuth / 他ドメイン / ランタイム削除を理由付きで除外し、「SSO ボタンは描画しない（嘘の導線を作らない）」までデザイン方針に接続している。チェックリストに無い作業の混入は見当たらない
- **ADR-007（プレースホルダールート）はスコープとして妥当**。`spec/inventory/frontend.md` の PAGE-common-001 は「選択で各画面（P-04/P-06/P-11/P-12/P-13）へ遷移する」、PAGE-login-005 は「P-03（/password-reset）への遷移リンクが**機能する**」と明記しており、非リンク化・項目削除では完了条件を満たさない。プレースホルダーは条件を満たす最小手段で、過剰実装にもなっていない
- **ADR-001（todo 削除）もスコープとして妥当**。ADP-users-001 / outbox 系3件が「fog の初期マイグレーション」を要求する以上、`todos` を含んだままの `0000_initial.sql` は spec/database と1対1にならない。加えて P-04 のパスが `/` である以上テンプレートの `routes/index.tsx` は必ず消える。共通基盤の統合テスト3本を破棄せず `users` へ移植すると明記している点が特に良い（ここを落とすと ADP-occ-guard-001 が実質空洞になる）
- **モバイルナビの解釈が spec/design の実体に合っている**。`spec/pages/index.md` は「モバイルは下部タブ相当」だが、承認済みデザイン `spec/design/pages/timeline.html` はヘッダーのメニューボタン（`aria-controls="nav-sh"`）から開く `.nav-sheet`（下部シート）で、`aria-current="page"` も既に入っている。AC-14 の「下部シート相当」「`aria-current` で現在地を明示」はデザイン成果物に忠実
- **テンプレート固有の罠を事前に拾えている**: `__root.tsx` へのクライアント島 action の副作用 import、マイグレーション2セットの再生成漏れが型検査で検出できないこと、`AppConfig` が `loadAppContext` 経由でクライアントへ渡るため `SESSION_SECRET` を入れてはいけないこと。いずれも実装後に発覚すると手戻りが大きい箇所で、リスク節に明記されている
- **DI ファクトリが4本（Node / Cloudflare / Aws / Gcp）であることを正しく把握している**。CLAUDE.md は3ランタイムしか記述していないが、実際には `application/di/serverGcp.ts` が存在する。plan は4本すべての更新を前提にしており、CLAUDE.md より実装の現況に忠実

## 補足（指摘ではない観測）

- ステップ14「デザイントークン全面置換」はチェックリスト ID に直接は対応しないが、PAGE-login-001 / signup-001 / common-001 を `spec/design/` に忠実に実装するための前提であり、`styles/tokens.css` / `theme.css` の差し替えという限定された作業なのでスコープ逸脱とは見なさない。ただし AC 表には対応行が無いので、AC-14 の脚注などに「トークン外の生値を書かない」を検証項目として足すと基準が閉じる
- `apps/web/.env`（サンプルではない実ファイル）がステップ11の対象ファイルに含まれている。ローカル起動導線としては必要だが、コミット対象かどうかは PR 時に確認したい
