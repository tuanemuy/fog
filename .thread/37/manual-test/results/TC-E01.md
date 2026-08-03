# TC-E01: 登録済みメールで再度サインアップするとフォーム内にエラーが出る

**結果**: PASS
**対応する受け入れ基準**: AC-2（signup saga の冪等・一意制約）/ AC-25 系のエラー契約

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログアウト後 `/signup` で `do-check@example.com` / `password123` を再送信 | 画面遷移せずフォーム内にエラー | URL は `http://localhost:3000/signup` のまま。フォーム内に **「このメールアドレスは登録済みです」** が表示され、`link "このメールアドレスでログインする"` が併せて出る。メールアドレス欄には送信値が残る（`textbox "メールアドレス": do-check@example.com`） | PASS |
| 2 | 500 画面・スタックトレースが出ないこと | 出ない | 出ていない。画面はサインアップフォームのまま | PASS |
| 3 | レスポンス（HAR で採取）を確認 | 翻訳済みのエラー契約 | HTTP **409**、ボディは<br>`{"kind":"conflict","code":"EMAIL_ALREADY_REGISTERED","message":"Request failed","retryable":false}`（TanStack のシリアライズ形式）| PASS |
| 4 | 生の例外文言 / `SQLITE_CONSTRAINT_UNIQUE` が出ていないこと | 出ない | レスポンスにも画面にも `SQLITE_` / `UNIQUE constraint failed` / `Durable Object` は一切現れない。`message` は汎用の `"Request failed"` に潰されている | PASS |

## 確認ポイントの結果

- **翻訳がアダプターに戻っているか** — 戻っている。同期 commit の UNIQUE 違反が `ConflictError("EMAIL_ALREADY_REGISTERED")` としてアダプター側で翻訳され、値エンベロープで request Worker まで戻り、`kind: "conflict"` として HTTP 409 にマップされて UI のフォーム内エラーになるところまで一気通貫で確認できた。
- **入力の保持** — `SignupForm` の `state.email` → `defaultValue` の作りが効いており、失敗してもメールアドレスの入力が消えない。
