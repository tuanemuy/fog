# Issue #19 根拠の記録

## AC ごとの根拠

| AC | 満たすコード | 確かめ方と結果 |
|---|---|---|
| AC-1 | `SsoNotice` の `ssoLinkErrorMessage("already_used")` → `SSO_IDENTITY_IN_USE_MESSAGE`（`apps/web/app/presentation/errorDisplay.ts`）。`CredentialList` が「連携を追加」の下に描く | ブラウザ（下の観測 O-1・O-2）。PASS |
| AC-2 | 同上 | ブラウザ（O-3・O-4）。PASS |
| AC-2b | 同上 | ブラウザ（O-5・O-6）。PASS |
| AC-3 | `renderConflictMessage` の `SSO_IDENTITY_ALREADY_REGISTERED` → `SSO_IDENTITY_IN_USE_MESSAGE` | `errorDisplay.test.ts`「an SSO identity already in use, whichever account holds it」。PASS |
| AC-4 | `renderSsoError("already_used", mode)` → `SSO_IDENTITY_IN_USE_MESSAGE`。`AuthForm` がフォームの先頭の `FormError` に描く | `authForm.dom.test.tsx`「login / signup draws a subject already in use without naming who holds it」。PASS |
| AC-5 | 同上 | ブラウザ（O-7〜O-10）。PASS |
| AC-6 | — | `rg -n "別のアカウントに連携" apps packages` の出力なし（exit 1） |
| AC-7 | 変更なし | `errorDisplay.test.ts`（`EMAIL_ALREADY_REGISTERED`）、`authForm.dom.test.tsx`（`email_registered` / `unverified` / `failed`）、`ssoNotice.dom.test.tsx`（`email_registered` / `unverified` / `failed`）が通る |

## テストと変異

足した・変えたテスト:

- `apps/web/app/presentation/__tests__/errorDisplay.test.ts`: `SSO_IDENTITY_ALREADY_REGISTERED` の期待値を所有者を問わない文言に変えた
- `apps/web/app/components/auth/__tests__/authForm.dom.test.tsx`: P-01 / P-02 の `already_used` の描画（2 件）を足した
- P-13 の `already_used` は既存の `ssoNotice.dom.test.tsx`「draws a link that did not go through under the link entry, and leaves the list as it was」が文言を字面で固定している

テストの期待値は定数から作らず字面で書いているので、定数の文言を変えると落ちる。

変異（3 つのテストファイルを実行。各変異は戻してから次へ）:

| 変異 | 種類 | 赤くなったテスト |
|---|---|---|
| M1 定数を「既に別のアカウントに連携されています」に戻す | 値の反転 | 4 件（errorDisplay 1・ssoNotice 1・authForm 2） |
| M2 `renderConflictMessage` の `SSO_IDENTITY_ALREADY_REGISTERED` の分岐を消す（既定の文言に落ちる） | ガード削除 | 1 件（errorDisplay） |
| M3 `renderSsoError` の `already_used` を `unverified` の分岐に落とす | 分岐の付け替え | 2 件（authForm login / signup） |
| M4 `ssoLinkErrorMessage` の `already_used` を失敗の分岐に落とす | 分岐の付け替え | 1 件（ssoNotice） |
| M5 `renderSsoError` の `already_used` に「（別のアカウント）」を足す | 値の変更 | 2 件（authForm login / signup） |

境界±1 は当てはまる数値の境界が無い。

## 変更が届く箇所

| 届く箇所 | 受け取るもの | 確かめ方 |
|---|---|---|
| `renderErrorMessage` / `displayError`（`errorDisplay.ts`） | `renderConflictMessage` の戻り値 | `errorDisplay.test.ts` の全件が通る。振る舞いが変わるのは `SSO_IDENTITY_ALREADY_REGISTERED` だけ |
| `displayError` を呼ぶ画面（`CredentialList`・`AuthForm`・`PasswordChangeForm` ほか） | 同上 | `SSO_IDENTITY_ALREADY_REGISTERED` を投げる usecase（`linkSsoCredential` / `registerOrLoginWithSso`）の呼び出し元は bare handler（`ssoHandlers.ts`）だけで、これらの画面の server function はこのコードを返さない（`rg SSO_IDENTITY_ALREADY_REGISTERED` で確認）。各画面の既存 DOM テストが通る |
| `AuthForm` の失敗の箱（P-01 / P-02） | `renderSsoError` の戻り値 | `authForm.dom.test.tsx` の全件と、ブラウザ O-7〜O-10 |
| `CredentialList` の連携の失敗（`useSsoLinkError`、P-13） | `ssoLinkErrorMessage` の戻り値 | `ssoNotice.dom.test.tsx` の全件と、ブラウザ O-1〜O-6 |
| `SsoNotice`（`"use client"`）と `SsoButtons` が新たに `@/presentation/errorDisplay` を読み込む | モジュールの依存 | `errorDisplay` は既に `"use client"` の `CredentialList` / `AuthForm` が読み込んでいる。`pnpm typecheck` が通り、ブラウザで P-01 / P-02 / P-13 が描画される |
| bare handler の `classifyFailure`（`ssoHandlers.ts`） | 変更なし（`already_used` を返す側） | `ssoHandlers.test.ts` が通る |

## 自動検証

`CLAUDE.md` の「After changes」と Development Commands から。

- `pnpm typecheck`: exit 0
- `pnpm lint`: exit 0（675 files、修正なし）
- `pnpm format:check`: exit 0
- `pnpm test:unit`: 162 files、1946 passed・2 skipped、exit 0
- `pnpm test:integration` は実行していない。変更は presentation 層とコンポーネントの文言だけで、integration の対象（Durable Object・usecase）に届かない

## 観測

環境: `vite dev`（`apps/web`、port 6830、`.dev.vars` は `.dev.vars.example` から作り、`SSO_DEV_STUB="true"`・`APP_URL="http://localhost:6830"`）。`agent-browser` namespace `issue-ship-25e966b2e958`。開発用 SSO スタブで主体を入力した。

状態の用意:

- アカウント A: `owner-a@example.com` でパスワード登録し、P-13 から Google の主体 `subject-own-S` を連携（`/settings?sso=linked`、トースト「外部アカウントを連携しました」）。一覧は「owner-a@example.com（メール・パスワード）」「Google（連携を解除）」の 2 行
- アカウント B: Google の主体 `subject-other-T` で SSO 登録し、P-13 から Google の主体 `subject-other-linked-U` を連携

| # | 対象 | 画面幅 | 期待 | 実際 | 判定 | 証跡 |
|---|---|---|---|---|---|---|
| O-1 | AC-1: A が P-13 から `subject-own-S` で連携 | 1280 | `/settings?sso_error=already_used`。「連携を追加」の後に `role="alert"`「この外部アカウントは既に使われています」。「別のアカウント」なし。一覧は 2 行のまま。トーストなし | 期待どおり（alert の幅 720px、ページ幅 1280 = scrollWidth） | PASS | `ac1-own-subject-1280.png` |
| O-2 | AC-1 を再読み込み | 375 | O-1 と同じ表示が残る。横スクロールなし | 期待どおり（alert x=38〜337、scrollWidth 375） | PASS | `ac1-own-subject-375-after-reload.png` |
| O-3 | AC-2: A が P-13 から `subject-other-T` で連携 | 1280 | O-1 と同じ | 期待どおり | PASS | `ac2-other-account-registered-1280.png` |
| O-4 | AC-2 を再読み込み | 375 | O-2 と同じ | 期待どおり | PASS | `ac2-other-account-registered-375.png` |
| O-5 | AC-2b: A が P-13 から `subject-other-linked-U` で連携 | 1280 | O-1 と同じ | 期待どおり | PASS | `ac2b-other-account-linked-1280.png` |
| O-6 | AC-2b | 375 | O-2 と同じ | 期待どおり | PASS | `ac2b-other-account-linked-375.png` |
| O-7 | AC-5: `/login?sso_error=already_used` | 1280 | メールアドレス欄より前の `role="alert"`「この外部アカウントは既に使われています」。「別のアカウント」なし | 期待どおり | PASS | `ac5-login-1280.png` |
| O-8 | 同上 | 375 | 同上。横スクロールなし | 期待どおり（x=38〜337、scrollWidth 375） | PASS | `ac5-login-375.png` |
| O-9 | AC-5: `/signup?sso_error=already_used` | 1280 | O-7 と同じ | 期待どおり | PASS | `ac5-signup-1280.png` |
| O-10 | 同上 | 375 | O-8 と同じ | 期待どおり | PASS | `ac5-signup-375.png` |

比べた既存画面: P-01 の `/login?sso_error=unverified`（375px、`compare-login-unverified-375.png`）。同じ `FormError` の箱・同じ位置に出ており、置き方がそろう。P-13 は変更の前後で文言が同じで、モック（spec/design/pages/settings.html「SSO 連携の追加が成立しない」）とは位置（「連携を追加」の後）が合い、文言はプロバイダ名の有無で食い違う（起票の下書きに回した）。

証跡の置き場所: `/private/tmp/claude-501/-Users-hikaru-github-com-tuanemuy-dotfiles-agents-skills/c8c03944-c01b-4c6e-a71d-35b79645f865/scratchpad/cmp/wt/fog-19-NEW.evidence/`
