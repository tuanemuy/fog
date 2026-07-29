# REG-FORM: ログイン / アカウント登録のフォーム動作

**結果**: PASS
**セッション**: verify-form

対象: `AuthSheet` が children を `<div className="mt-section flex flex-col">` でラップして DOM が 1 段深くなったことによる、`<form>` の送信・エラー表示・フォーカス移動・`defaultValue` 復元・縦余白への影響。

使用アカウント: `appshell-check@example.com` / `password123`（先行検証で作成済み。新規作成は不要だった）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/login` を開き、送信前の余白を計測 | ブランド→見出し 36px、見出し→フォーム 36px | `gapBrandH1: 36`、`gapH1Wrap: 36`、`gapH1Form: 36`（ラッパー `div.mt-section flex flex-col` の `margin-top` は `36px`、`h1` の `margin-top` も `36px`。ラッパーの top と `<form>` の top が一致＝ラッパーは余白以外を足していない） | PASS |
| 2 | `appshell-check@example.com` + `wrongpassword123` で送信 | エラーメッセージが `<form>` 内に表示される | `snapshot` に `form > alert "メールアドレスまたはパスワードが正しくありません"`。DOM 上も `role="alert"` の `<p>` の `parentElement` が `FORM` | PASS |
| 3 | 送信直後の `document.activeElement` を確認 | エラー該当要素（フォームレベルなのでエラーメッセージ）にフォーカス | `tagName: "P"` / `role: "alert"` / `tabindex: "-1"` / `textContent: "メールアドレスまたはパスワードが正しくありません"`。`ae === document.querySelector("[role=alert]")` が true、`form.contains(ae)` も true、`ae === document.body` は false | PASS |
| 4 | 失敗後のフォーム値を確認 | メールアドレスが残り、パスワードは消える | `#login-email.value = "appshell-check@example.com"`（`state.email` → `defaultValue` の復元経路が生きている）、`#login-password.value = ""` | PASS |
| 5 | エラー表示状態で余白を再計測 | ブランド→見出し 36px、見出し→フォーム 36px（1 と同値） | `gapBrandH1: 36`、`gapH1Wrap: 36`、`gapH1Form: 36`。`FormMessage` は `<form>` の `gap-lg` 内に増えるだけで、シート側の余白は不変 | PASS |
| 6 | 同じフォームでパスワードを `password123` に直して送信 | ログイン後の画面に遷移し URL が `/login` から変わる | `wait --load networkidle` 後に URL が `http://localhost:3000/`。`snapshot` に `banner > heading "タイムライン"`、グローバルナビ（タイムライン / トピック / 検索 / ゴミ箱 / 設定）、`main > "まだメモがありません"` | PASS |
| 7 | `/signup` を開く（ログイン状態） | — | ログイン済みだと `/` にリダイレクトされたため、`/settings` の「ログアウト」で一度サインアウト（URL が `/login` に遷移）してから再度 `/signup` を開いた | PASS（参考） |
| 8 | `/signup` のフォームが操作可能か確認 | 入力欄・送信ボタンが `is enabled` | `#signup-email` true / `#signup-password` true / `button[type=submit]` true。`form` 直下の `input`・`button` はいずれも `disabled: false` | PASS |
| 9 | `/signup` の余白も計測（ラッパー追加の影響確認） | `/login` と同値 | `gapBrandH1: 36`、`gapH1Wrap: 36`、`gapH1Form: 36`、`wrapClass: "mt-section flex flex-col"` | PASS |

新規登録は実施していない（既存アカウントでログインできたため、手順書どおり登録は不要）。

## 計測値

送信前 / エラー表示後（`/login`、同一値）:

```
gapBrandH1 (ブランド下端 → h1 上端): 36px
gapH1Wrap  (h1 下端 → ラッパー div 上端): 36px
gapH1Form  (h1 下端 → form 上端): 36px
h1.marginTop: 36px
wrapper: <div class="mt-section flex flex-col"> marginTop: 36px
wrapper.top === form.top (220.265625) — ラッパー自身は高さ・余白を追加していない
```

`/signup`:

```
gapBrandH1: 36px / gapH1Wrap: 36px / gapH1Form: 36px
wrapClass: "mt-section flex flex-col"
```

エラー送信後の `document.activeElement`:

```
tagName:     P
id:          (なし)
name:        null
role:        alert
tabindex:    -1
textContent: メールアドレスまたはパスワードが正しくありません
ae === document.querySelector("[role=alert]"): true
form.contains(ae): true
ae === document.body: false
alert.parentElement: FORM
```

フォーム値:

```
#login-email.value:    appshell-check@example.com   （defaultValue で復元）
#login-password.value: ""                            （意図どおり持ち回さない）
location.pathname:     /login                        （失敗時は遷移しない）
```

## 失敗詳細（FAILの場合）

なし。

## 気づいた点

- `LoginForm` の `useEffect` は `emailRef` / `passwordRef` / `formMessageRef` という ref 参照でフォーカス先を決めており、DOM の階層深さに依存しない。今回のラッパー追加で壊れる構造ではなく、実測でも意図どおり `FormMessage` にフォーカスが乗った。
- 資格情報エラーはフィールド単位ではなくフォームレベル（`display.form`）に落ちる設計のため、フォーカス先はパスワード欄ではなく `role="alert"` の `<p>`（`tabindex="-1"`）。手順書の「パスワード入力欄、またはフォームレベルのエラーメッセージ」の後者に該当する。
- ラッパー `div.mt-section` は `h1` の直後にあり、`flex flex-col` なので `margin-top` は相殺されず 36px がそのまま効く（`AuthSheet` の JSDoc が言う「最初の子は自前の `margin-top` を持たない」前提）。`LoginForm` 側の `<form>` に `margin-top` がないことも実測で確認済み（`wrapper.top === form.top`）。
- ログイン済みで `/signup` を開くと `/` にリダイレクトされる。`/signup` の描画確認にはサインアウトが必要。
