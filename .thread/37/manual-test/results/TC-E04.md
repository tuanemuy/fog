# TC-E04: 未認証で保護画面を直接開くと `?redirect=` 付きでログインに飛び、ログイン後に戻る

**結果**: PASS
**対応する受け入れ基準**: AC-19 / AC-29（既存動線が DO 移行の巻き添えを受けていないこと）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | cookie が無い状態で `http://localhost:3000/settings` を直接開く | ログインへリダイレクト | `agent-browser cookies get` が空であることを確認したうえで開き、`http://localhost:3000/login?redirect=%2Fsettings` に着地 | PASS |
| 2 | 同じ URL を `curl -i` | 307 + `location` | `HTTP/1.1 307 Temporary Redirect` / `location: /login?redirect=%2Fsettings` | PASS |
| 3 | 遷移先 URL を確認 | `/login?redirect=%2Fsettings` | 一致 | PASS |
| 4 | `do-check@example.com` / `password123` でログイン | `/` ではなく `/settings` に戻る | ログイン後 URL = `http://localhost:3000/settings`、`main` = 「アカウント / 認証方式 / メールアドレスとパスワード / ログアウト」 | PASS |

## 補足（1回目の試行が失敗した理由）

手順4 を最初に実行したときは、正しい資格情報にもかかわらず「メールアドレスまたはパスワードが正しくありません」で弾かれた。原因は **TC-E02 の失敗ログイン6連発で `credential_mappings.next_attempt_allowed_at` によるバックオフが有効だったため**で、`?redirect=` の動線とは無関係だった。バックオフ期間（約15秒）を過ぎてから同じ操作をやり直したところ、上表のとおり `/settings` へ戻った。詳細は TC-E02 の「副次的に確認できたこと」に記録した。
