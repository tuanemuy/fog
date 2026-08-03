# TC-C04: ログアウトしてから同じ資格情報でログインできる

**結果**: PASS
**対応する受け入れ基準**: AC-2 / AC-4

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/settings` で「ログアウト」を押す | ログアウトして `/login` へ | `http://localhost:3000/login?redirect=%2Fsettings` へ遷移。セッション cookie（`fog_session`）が消える（`agent-browser cookies get` の出力が空） | PASS |
| 2 | ログアウト中のボタン状態を観察 | `useTransition` の pending | 記録: `{text:"ログアウト", disabled:false, aria-busy:null}` → `{text:"ログアウト中…", disabled:true, aria-busy:"true"}` | PASS |
| 3 | ブラウザバックで `/settings` に戻れないこと | 戻れない | `back` の結果 URL は `http://localhost:3000/login?redirect=%2F`、`main` はログインフォーム。`/settings` の描画には戻らない | PASS |
| 4 | `do-check@example.com` / `password123` でログイン | 成功してタイムラインへ | `http://localhost:3000/`、`main` = 「まだメモがありません」 | PASS |
| 5 | 大文字混じり `DO-Check@Example.com` でログイン | 成功 | 送信前の input value = `"DO-Check@Example.com"`。送信後 `http://localhost:3000/`、`main` = 「まだメモがありません」 | PASS |
| 6 | 前後に空白を入れた ` do-check@example.com ` でログイン | 成功 | 下記のとおり **FormData に空白付きのまま載せて**送信し成功。`http://localhost:3000/`、`main` = 「まだメモがありません」 | PASS |

## 手順6 の実施方法（重要）

`<input type="email">` は HTML の value sanitization により**ブラウザ側で前後の空白を落とす**ので、素直に空白付きで入力しても `trim()` がサーバーへ届く前に消えてしまい、`Email.create` の `trim()` を検証したことにならない。実際、最初の試行では入力値が `"do-check@example.com"`（空白なし）になっていた。

そこで `type` を `text` に変えたうえで `HTMLInputElement.prototype.value` の native setter で値を入れ、送信直前に `new FormData(form).get('email')` を実測して空白が残っていることを確認してから `form.requestSubmit()` した。

```
{"emailValue":" do-check@example.com ","formDataEmail":" do-check@example.com "}
```

この状態でログインが成功したので、**canonical 化（`trim()` → local 部 lowercase / domain 部 NFKC + lowercase）がサーバー側で効いており、3パターンすべてが同じ mapping 行に解決している**ことが確認できた。手順5 の大文字混じりと合わせて、ドメイン層と Identity Directory DO 側の canonical 化に食い違いは無い。

## 確認ポイントの結果

- **canonical 化の食い違い** — 無し（上記）。
- **ログアウト後のブラウザバック** — `/settings` に戻れない（手順3）。
- **ログアウトで `sessionEpoch` を進めない** — 進んでいない。ログアウト前に発行されていた cookie の payload は `ep: 0`（`{"typ":"session","uid":"019fc580-…","ep":0,"exp":…}`）で、ログアウト後に再ログインしても User Data DO の `account.session_epoch` は `0` のまま（DO の SQLite を read-only コピーして実測）。epoch を進めていたら再ログイン前の値が 1 以上になるはずなので、進めていないことの裏返しになる。
