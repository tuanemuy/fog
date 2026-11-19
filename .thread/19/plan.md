# Issue #19 契約

## 目的

SSO 主体が既に使われていて連携・登録が成立しないとき、画面の文言が主体の持ち主（別のアカウント / 自分のアカウント）を言い当てない形になっている。spec/pages P-13「対象の主体が既に使われている（別のアカウント / 自分のアカウントを問わない）場合はその旨を表示し、クレデンシャル一覧は変わらない」に従う。

## 着手時の事実

- P-13 の連携失敗は、bare handler（`apps/web/app/worker/cloudflare/ssoHandlers.ts`）が `ConflictError` を `?sso_error=already_used` に変えて `/settings` へ戻し、`SsoNotice` の `ssoLinkErrorMessage` が「この外部アカウントは既に使われています」を出す。Issue が起票された翌日のコミット e7b8d44 でこの文言になっており、P-13 の画面に出る文言は既に所有者を問わない。ブラウザでの実測で確かめる（AC-1・AC-2）
- 「既に別のアカウントに連携されています」は、次の 2 箇所に残っている
  - `apps/web/app/presentation/errorDisplay.ts` の `renderConflictMessage`: `SSO_IDENTITY_ALREADY_REGISTERED` の文言。spec/usecases/identity.md はこのコードを「自分のアカウントで連携済みの場合も同じ」と定める。このコードを投げる usecase（`linkSsoCredential` / `registerOrLoginWithSso`）の呼び出し元は bare handler だけで、bare handler は衝突を `sso_error` に変えて redirect する。いまこの文言に届く画面は無く、単体テスト（AC-3）でだけ観測できる
  - `apps/web/app/components/auth/SsoButtons/index.tsx` の `renderSsoError`（P-01 / P-02）: `already_used` の文言。bare handler の `classifyFailure` は `EMAIL_ALREADY_REGISTERED` 以外の `ConflictError` をすべて `already_used` にする。P-01 / P-02 でそこに至るのは、spec/usecases/identity.md が挙げる同じ SSO 主体での同時初回サインインのレースの負け、SSO 主体を coordinator にした予約の確定（commit / activate）の失敗、ほかの衝突。どの場合も、主体を誰が持つかを画面側は知らない。spec が挙げるレースでは、主体を取ったのは同じ主体での別のリクエストが作ったアカウントで、「別のアカウント」とは言えない

## 要求の項目と AC

| 要求の項目 | 出どころ | 覆う AC |
|---|---|---|
| R1. P-13 の SSO 連携追加で、自分のアカウントに連携済みの主体を選んだとき、「別のアカウント」と言わずに、主体が既に使われている旨を表示する | Issue「現状」 | AC-1 |
| R2. P-13 の SSO 連携追加で、別のアカウントに連携済みの主体を選んだときも、同じ所有者を問わない文言を表示する（spec P-13「問わない」）。別のアカウントが主体を持つ経路は、SSO での登録と P-13 からの連携の 2 つ | Issue「現状」・「根拠」 | AC-2・AC-2b |
| R3. R1・R2 のどちらでも、クレデンシャル一覧は変わらない | Issue「根拠」（spec P-13） | AC-1・AC-2・AC-2b |
| R4a. 主体が既に使われていることを伝える文言を、所有者を問わない形にする: P-13 の `already_used` | Issue「対応案」 | AC-1・AC-2・AC-2b（画面）、既存の `ssoNotice.dom.test.tsx` |
| R4b. 同じ: P-01 ログインの `already_used` | Issue「対応案」（同じ原因が通る経路） | AC-4・AC-5 |
| R4c. 同じ: P-02 アカウント登録の `already_used` | Issue「対応案」（同じ原因が通る経路） | AC-4・AC-5 |
| R4d. 同じ: `SSO_IDENTITY_ALREADY_REGISTERED` の表示文言（いま届く画面は無い） | Issue「対応案」（同じ原因が通る経路） | AC-3 |
| R4e. 文言の変更は上の 4 つに限り、同じ表のほかのコードの文言は変わらない | quality.md「要件が変えない振る舞いは変わっていない」 | AC-7 |
| （網羅） | | AC-6 |

### AC

- AC-1（`browser`）: ログイン中のアカウントに Google の主体 S を連携済みの状態で、P-13 の「連携を追加」から同じ S で連携を試みると、`/settings` に戻り、「連携を追加」の下に「この外部アカウントは既に使われています」が `role="alert"` で出る。「別のアカウント」を含む文言は画面のどこにも出ない。ログイン手段の一覧は試みる前と同じ行のまま
- AC-2（`browser`）: 別のアカウントが Google の主体 T で SSO 登録済みの状態で、ログイン中のアカウントの P-13 から T で連携を試みると、AC-1 と同じ文言・同じ位置で表示され、一覧は変わらない
- AC-2b（`browser`）: 別のアカウントが P-13 から Google の主体 U を連携済みの状態で、ログイン中のアカウントの P-13 から U で連携を試みると、AC-1 と同じ文言・同じ位置で表示され、一覧は変わらない
- AC-3（自動テスト）: `displayError` / `renderErrorMessage` は `kind: "conflict"`・`code: "SSO_IDENTITY_ALREADY_REGISTERED"` を「この外部アカウントは既に使われています」にする
- AC-4（自動テスト・DOM テスト）: `AuthForm` に `mode` が `login` / `signup`、`ssoError="already_used"` を渡すと、フォームの先頭の `role="alert"` に「この外部アカウントは既に使われています」が出る
- AC-5（`browser`）: `/login?sso_error=already_used` と `/signup?sso_error=already_used` を開くと、それぞれのフォームの先頭に `role="alert"` で「この外部アカウントは既に使われています」が出て、「別のアカウント」を含む文言は画面に出ない
- AC-6（コマンド出力）: `rg "別のアカウントに連携" apps packages` が何も返さない
- AC-7（自動テスト）: `EMAIL_ALREADY_REGISTERED`（`renderErrorMessage`）、`email_registered` / `unverified` / `failed`（P-01 / P-02 の `AuthForm`、P-13 の `ssoLinkErrorMessage`）の文言は変わらない。既存の `errorDisplay.test.ts`・`authForm.dom.test.tsx`・`ssoNotice.dom.test.tsx` が固定している

### 観測の対象（AC 以外で、結果がユーザーに見えるもの）

- 連携失敗の表示後に再読み込みしても同じ表示のまま（URL の `sso_error` が残るため）で、一覧は変わらない
- 連携失敗の表示は成功のトースト（「外部アカウントを連携しました」）を出さない

## 画面の文言

| 文言 | 読み手（画面と役割） | 語彙の決まりと出どころ |
|---|---|---|
| この外部アカウントは既に使われています | P-13 設定: ログイン中で、自分で SSO 連携を始めた利用者 | 「外部アカウント」は SSO 主体を指す画面の語（spec/requirements.md「外部アカウント連携」、spec/pages P-13「外部アカウント連携」、既存の `SsoNotice` / `SsoButtons` の文言）。「既に使われている」は spec/pages P-13・spec/scenario/account.md S-AC-02 の言い方 |
| 同上 | P-01 ログイン / P-02 アカウント登録: 未ログインで SSO で続行した利用者 | 同上。P-01 / P-02 のモック（spec/design/pages/login.html・signup.html）はこの状態の例を持たないので、同種の画面である P-13 の実装の文言にそろえる |

P-13 のモック（spec/design/pages/settings.html の「SSO 連携の追加が成立しない」の例）は「この Apple アカウントは既に使われています」とプロバイダ名で言う。実装はこの変更の前から「外部アカウント」で言っており、bare handler の redirect はプロバイダを運ばない。モックにそろえるには経路の変更が要るので、この変更では扱わず起票する（下の「スコープ」）

## 対象の画面幅

プロジェクトはブレークポイント（spec/design/tokens.md）を定めるが、確かめる画面幅は定めていない。モバイル基準の 375px と、`xl` の 1280px を対象にする。

## 設計

- 文言は 1 か所で定める。`apps/web/app/presentation/errorDisplay.ts` に定数を置き、`renderConflictMessage` の `SSO_IDENTITY_ALREADY_REGISTERED`、`SsoNotice` の `already_used`、`SsoButtons` の `already_used` がそれを使う。3 つは同じ事実（SSO 主体が既に予約済み）を同じ読み手に向けて言う

## スコープ

- 含む: 上の 3 箇所の文言、それを固定するテスト（`errorDisplay.test.ts` の期待値、`authForm.dom.test.tsx` の `already_used` の DOM テスト）
- 含まない（起票の下書きに回す。どれもこの変更の前のツリーで同じ入力から起きる）
  - bare handler の `classifyFailure` が、主体の予約と関係のない `ConflictError`（`OPTIMISTIC_LOCK_FAILURE`・`OPERATION_PAYLOAD_MISMATCH` など）も `already_used` にし、「既に使われています」と出すこと
  - spec/usecases/identity.md registerOrLoginWithSso の手順3「UI はパスワードログインへの導線を示す」を、`AuthForm` は `email_registered` の P-02 にしか出さないこと
  - P-13 の文言がモックのプロバイダ名（「この Apple アカウントは…」）と食い違うこと

## ユーザーの答え

- P-01 / P-02 の `already_used` も同じ文言に揃える（R4 に含める）。Issue は P-13 を挙げるが、P-01 / P-02 の文言も同じ原因（持ち主の言い当て）で、そこへ至るレースでは持ち主は同じ主体の利用者になる（ユーザー不在のため代行）
