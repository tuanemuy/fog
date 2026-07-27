# TC-001 Round 2: 修正後サーバーで設定画面の再読み込みを再検証

**結果**: FAIL
**実行時間**: 64秒
**セッション**: verify-tc-001-r2
**実行日時**: 2026-07-28 06:15:01〜06:16:05 JST

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|---|---|---|---|
| 1 | 修正後サーバーの`http://localhost:8787/login`を開き、snapshotを取得する | ログインフォームが表示される | 見出し「ログイン」、メール欄`@e4`、パスワード欄`@e5`、ログインボタン`@e6`が表示された | PASS |
| 2 | 既存アカウントを`fill → Tab → fill → Tab`で入力し、snapshot ref `@e6`からログインする | 認証に成功する | `http://localhost:8787/`へ遷移し、認証済みのタイムラインとグローバルナビゲーションが表示された | PASS |
| 3 | snapshot ref `@e8`から「設定」を開く | `/settings`が表示される | URLは`http://localhost:8787/settings`となり、設定画面が表示された | PASS |
| 4 | 設定見出し、メール、認証方式、URLを確認する | 見出しと既存アカウント情報が表示される | 見出し「設定」、メール`issue19-password-20260728t-browser1@example.com`、認証方式「メールアドレスとパスワード」を確認した。URLは`/settings`だった | PASS |
| 5 | reload前のconsoleとpage errorをJSONで確認する | ブラウザエラーがない | console messages、page errorsともに空だった | PASS |
| 6 | `/settings`をreloadし、「設定」の再表示を最大30秒待つ | セッションと設定画面が維持される | URLは`http://localhost:8787/settings`を維持したが、30秒で待機がtimeoutし、snapshotは`(empty page)`だった | FAIL |
| 7 | reload後のconsoleとpage errorをJSONで確認する | ブラウザエラーがない | console messagesは空だった。page errorに`ReferenceError: __name is not defined`が1件あり、`/settings`のインラインスクリプトから始まるstackが記録された | FAIL |

## 失敗詳細

- **失敗ステップ**: Step 6、Step 7
- **期待**: reload後30秒以内に設定見出し、メール、認証方式が再表示され、console/page errorがない
- **実際**: URLは`/settings`のままだが、設定見出しは30秒で出現せずsnapshotは`(empty page)`だった。page errorに`ReferenceError: __name is not defined`が記録された
- **page error発生位置**: `http://localhost:8787/settings:2:77`から始まり、`/settings:22`と`/assets/index-C3HccvoR.js`を通るstack
- **console**: JSON出力のmessagesは空
- **再現性**: 初回TC-001とRound 1の白画面を、修正後に再起動されたサーバーでも再現した

## 分析

loginとクライアント遷移によるsettings表示は正常であり、reload前には設定情報がすべて表示され、console/page errorもなかった。失敗はfull reload後だけに限定される。

Round 1ではpage errorが空だったが、Round 2では`ReferenceError: __name is not defined`を取得できた。少なくとも今回は認証失敗やURL遷移ではなく、`/settings`のfull reload後に実行されるインラインスクリプトまたはそのhydration/stream処理が未定義の`__name`を参照して描画を中断していることが、白画面と直接対応している。

## 補足

- cookie値、入力したパスワード、内部識別子、画像は成果物に記録していない。
- 指定sessionは終了後にcloseし、残存agent-browserプロセスもクリーンアップした。
- 稼働中のworkerdサーバーとローカル永続データは変更・停止していない。
- コード修正、Issue起票、commit、pushは行っていない。
