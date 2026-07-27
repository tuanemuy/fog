# アカウント・認証 テスト

Issue #19でユーザー向けに検証するのは既存 #1 のパスワード登録、パスワードログイン、current user、logoutのみ。password changeは#11、password reset/SSO OAuth/link/unlinkは#12でUIを提供する。#19ではそれら将来機能のprimitive/schema/contract testだけを自動検証する。

## 前提

- request Workerとstate/DO Workerがmulti-configで起動している
- User Data / Identity Directory / Account Homeの3 DO classがbindingされている
- request Workerだけに`SESSION_SECRET`と`DIRECTORY_ROUTING_SECRET`が設定され、state Workerにはない
- テストごとに未使用のメールアドレスを使う

## TC-01: パスワード登録

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | signup画面を開く | email/password入力と送信ボタン |
| 2 | 未登録emailと8文字以上のpasswordで送信 | 1つのaccountが作成されtimelineへ遷移 |
| 3 | settings/current userを開く | email、auth method、既定trash retention 30。hash/locatorは表示されない |
| 4 | 同じemailで再登録 | `EMAIL_ALREADY_REGISTERED`。二重accountなし |

## TC-02: 登録の再送

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | 未登録emailで送信ボタンを素早く複数回押す | 送信中表示。利用者からは1回だけ成功 |
| 2 | logout後に同じcredentialでlogin | 同じuserId/accountへlogin |

stable operation IDと各fault pointの厳密な再開はworkerd fault injection testで確認する。

## TC-03: email正規化

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | `  New-User@Example.COM  `で登録 | 正常登録 |
| 2 | logoutし`new-user@example.com`でlogin | 同じaccount |
| 3 | 大文字表記で再登録 | 正規化後の重複error |

## TC-04: password login

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | 登録済みemail/passwordでlogin | timelineへ遷移 |
| 2 | 保護URLを直接開く | login状態を維持し表示 |
| 3 | logout | login画面へ戻る |
| 4 | 保護URLを再度開く | login画面へredirect |

## TC-05: credential enumeration耐性

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | 未登録emailでlogin | 汎用的な「メールアドレスまたはパスワードが正しくない」 |
| 2 | 登録済みemail + 誤password | 手順1と同じ表示/status |
| 3 | SSO-onlyテストcredential + 任意password | 手順1と同じ表示/status |
| 4 | 不正email/短すぎるpassword | 手順1と同じ表示/status |

dummy/実verifyの呼出回数とログ非PIIは自動contract testで確認する。

## TC-06: 元URLへ復帰

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | logout状態でsettings URLへ直接アクセス | login画面へredirect |
| 2 | 正しいcredentialでlogin | 元のsettingsへ復帰 |

## TC-07: current user片側障害

通常の手動環境ではfault injectionしない。workerd testでAccount HomeまたはUser Dataの片側をunavailableにし、古い片側だけでsuccessにならずretryable errorになることを確認する。

## TC-08: 公開routing入力

browser/network inspectorでsignup/login/current user requestを確認し、DO ID、bucket、partition key、userId overrideが送信payload/URLに存在しないことを確認する。

## 将来機能の引継ぎ

- #11: password change UI/usecase
- #12: password reset、SSO OAuth、link/unlink UI/usecase
- #15: export UI/usecase

#19の自動testは上記に先行して、reset token、mail Alarm job、SSO lookup/create、link/unlink、session epoch、deletion tombstone/epochのprimitive contractを固定する。
