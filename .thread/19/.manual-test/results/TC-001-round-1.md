# TC-001 Round 1: 設定画面の再読み込みを既存アカウントで再検証

**結果**: FAIL
**実行時間**: 99秒
**セッション**: verify-tc-001-r1
**実行日時**: 2026-07-28 06:07:40〜06:09:19 JST

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|---|---|---|---|
| 1 | `http://localhost:8787/login`を開き、snapshotを取得する | ログインフォームが表示される | 見出し「ログイン」、メール欄`@e4`、パスワード欄`@e5`、ログインボタン`@e6`が表示された | PASS |
| 2 | 既存アカウントのメールとパスワードを`fill → Tab → fill → Tab`で入力し、snapshot ref `@e6`からログインする | 認証に成功する | `http://localhost:8787/`へ遷移し、認証済みのタイムラインとグローバルナビゲーションが表示された | PASS |
| 3 | snapshot ref `@e8`から「設定」を開く | `/settings`が表示される | URLは`http://localhost:8787/settings`となり、設定画面が表示された | PASS |
| 4 | 設定見出し、メール、認証方式、URLを確認する | 見出しと既存アカウント情報が表示され、URLに内部識別子が露出しない | 見出し「設定」、メール`issue19-password-20260728t-browser1@example.com`、認証方式「メールアドレスとパスワード」を確認した。URLは`/settings`だけだった | PASS |
| 5 | reload前のconsoleとpage errorをJSONで確認する | ブラウザエラーがない | console messages、page errorsともに空だった | PASS |
| 6 | `/settings`をreloadし、「設定」の再表示を最大30秒待つ | セッションと設定画面が維持される | URLは`http://localhost:8787/settings`を維持したが、30秒で待機がtimeoutした。snapshotは`(empty page)`、titleも空だった | FAIL |
| 7 | 一時スクリーンショットを取得して実画面を確認し、consoleとpage errorを再確認する | snapshotだけの取得不良ではなく、画面状態とエラー有無を判定できる | `view_image`で画面全体が空の淡い背景であることを確認した。console messagesとpage errorsはreload後も空だった。一時画像は確認後に削除した | PASS |

## 失敗詳細

- **失敗ステップ**: Step 6
- **期待**: reload後30秒以内に`/settings`のシェル、設定見出し、メール、認証方式が再表示される
- **実際**: URLは`/settings`のままだが、設定見出しは30秒で出現せず、snapshotは`(empty page)`、titleは空だった
- **画面状態**: 一時スクリーンショットを`view_image`で確認した結果、実画面も全面が空の淡い背景だった。アクセシビリティsnapshotだけの欠落ではない
- **console / page error**: JSON出力でいずれも空
- **再現性**: 初回TC-001のStep 8と同じ症状を、既存アカウントからの新規セッションで再現した

## 分析

前回reload時のサーバーログでは`/settings`とアセットがすべてHTTP 200だった。今回もlogin、クライアント遷移によるsettings表示、認証情報の表示までは正常で、reload後もURLとセッション遷移先は`/settings`を維持し、console/page errorもない。

したがって、単純な認証失敗、HTTPエラー、snapshot抽出だけの問題ではない。full reload後のSSR/RSC応答から画面が描画されるまでの経路、またはagent-browserのChrome lifecycleとの組合せに再現条件がある可能性が高いが、この再検証だけでは根本原因は確定できない。

## 補足

- cookie値、入力したパスワード、内部識別子は記録していない。
- 指定sessionは終了後にcloseし、残存agent-browserプロセスもクリーンアップした。
- 稼働中のworkerdサーバーとローカル永続データは変更・停止していない。
- コード修正、Issue起票、commit、pushは行っていない。
