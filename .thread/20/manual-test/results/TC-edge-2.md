# TC-edge-2: 未知のアルゴリズム識別子を持つ行は資格情報エラーに潰れない

**結果**: PASS
**実行時間**: 約 150 秒

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `apps/web/broken.sql` に `UPDATE users SET password_hash = 'argon2id$1000$c2FsdA==$aGFzaA==' WHERE email = 'pbkdf2-new@example.com';` を書き `pnpm db:execute:local ./broken.sql` を実行 | 行が更新される | `1 command executed successfully`。`SELECT` で `password_hash` = `argon2id$1000$c2FsdA==$aGFzaA==` を確認 | PASS |
| 2 | `/login` で `pbkdf2-new@example.com` / `password123` を送信 | ログインが成功しない。資格情報エラーに潰れない | `/login` に留まり、フォーム冒頭の `alert` に **「システムエラーが発生しました」** のみ表示。「メールアドレスまたはパスワードが正しくありません」ではない | PASS |
| 3 | 画面へのハッシュ値・スタックトレース露出を確認（`document.documentElement.outerHTML` を検査） | ハッシュ値も内部スタックトレースも出ない | `'argon2id'` / `'pbkdf2PasswordHasher'` / `'aGFzaA'` いずれも HTML に含まれず（`false|false|false`）。表示文言は「システムエラーが発生しました」だけ | PASS |
| 4 | サーバーログ（`/tmp/manual-test-server.log`）を確認 | `DataIntegrityError` 相当（`Stored password hash is not in a recognised encoding`）が出る | `kind: 'system'` / `code: 'DATA_INTEGRITY_ERROR'` / `message: 'Stored password hash is not in a recognised encoding'` が出力（全文は下記） | PASS |
| 5 | `broken.sql` を元の値へのUPDATEに書き換えて実行し、`SELECT` で確認 | 元の保存値に戻る | `pbkdf2-sha512$210000$A+nBkT1WYxS42vc1/mL2og==$YvS1t70atHVpLKrQTu33wKPwpTc6dXLS/aX65KfbEWs=` に一致 | PASS |
| 6 | 復元後の値で `/login` に `pbkdf2-new@example.com` / `password123` を送信 | ログインできる | `/timeline`（「タイムライン」見出し・グローバルナビゲーション）へ遷移、ログイン成功 | PASS |
| 7 | `apps/web/broken.sql` を削除、`git status --short` を確認 | 作業ツリーに残骸なし | 結果ファイル2件（`TC-edge-2.md` / `TC-edge-3.md`）以外に差分なし。`.sql` の残骸なし | PASS |

## 確認ポイントの判定

- `parse()` の失敗を握り潰す catch は存在しない。`SystemError(DataIntegrityError)` が `verify()` → `loginWithPassword` → サーバー関数境界まで無変換で到達し、`INVALID_CREDENTIALS` に潰れていない
- スタックトレースが示すとおり `verify()` の throw は `burnVerificationTime` の外側にある（`pbkdf2PasswordHasher.ts:242` の `verify` から直接 `parse` を呼んで throw）

## サーバーログ差分（全文）

テスト開始時 154 行 → 終了時 172 行。増分は次のブロックのみ（TC-edge-3 の登録・ログインはログを一切出していない）。

```
Server function failed {
  kind: 'system',
  code: 'DATA_INTEGRITY_ERROR',
  message: 'Stored password hash is not in a recognised encoding',
  cause: SystemError: Stored password hash is not in a recognised encoding
      at parse (/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:156:11)
      at Object.verify (/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:242:22)
      at Module.loginWithPassword (/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/application/identity/loginWithPassword.ts:163:50)
      at Object.serverFn (/Users/hikaru/github.com/tuanemuy/fog/apps/web/app/components/auth/LoginForm/action.ts?tss-serverfn-split:14:24)
      at server (/Users/hikaru/github.com/tuanemuy/fog/node_modules/.pnpm/@tanstack+start-client-core@1.170.14/node_modules/@tanstack/start-client-core/src/createServerFn.ts:944:24)
      at callNextMiddleware (/Users/hikaru/github.com/tuanemuy/fog/node_modules/.pnpm/@tanstack+start-client-core@1.170.14/node_modules/@tanstack/start-client-core/src/createServerFn.ts:322:24)
      at userNext (/Users/hikaru/github.com/tuanemuy/fog/node_modules/.pnpm/@tanstack+start-client-core@1.170.14/node_modules/@tanstack/start-client-core/src/createServerFn.ts:312:26)
      at /Users/hikaru/github.com/tuanemuy/fog/apps/web/app/presentation/errorResponseMiddleware.ts:27:12
      at callNextMiddleware (/Users/hikaru/github.com/tuanemuy/fog/node_modules/.pnpm/@tanstack+start-client-core@1.170.14/node_modules/@tanstack/start-client-core/src/createServerFn.ts:322:24)
      at Object.assign.__executeServer (/Users/hikaru/github.com/tuanemuy/fog/node_modules/.pnpm/@tanstack+start-client-core@1.170.14/node_modules/@tanstack/start-client-core/src/createServerFn.ts:212:20) {
    code: 'DATA_INTEGRITY_ERROR'
  }
}
```

ログにも保存値（`argon2id$...`）そのものは出ていない。

## 後始末

- `pbkdf2-new@example.com` の `password_hash` を元の値へ復元済み（手順5でバイト一致を確認、手順6でログイン成功を確認）
- `apps/web/broken.sql` 削除済み
