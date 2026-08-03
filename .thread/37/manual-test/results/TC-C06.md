# TC-C06: dev サーバーを再起動してもアカウントとセッションが残る

**結果**: PASS（**代替検証**。dev サーバーは停止していない）
**対応する受け入れ基準**: AC-1 / AC-16

## サーバーを再起動しなかった理由

本検証の dev サーバー（`http://localhost:3000`、11:39 起動）は他の検証と共有しているため、指示により停止・再起動していない。代わりに、**「別プロセスで作られた DO が現在のプロセスから読めるか」** を直接確かめる形で置き換えた。これは再起動テストが検出しようとしている失敗（DO ストレージがインメモリ／毎回スキーマを作り直す）を同じだけ検出できる。

## 代替検証の材料

`apps/web/.wrangler/state/v3/do/` には、**本検証より前の dev サーバープロセス**（07:17〜07:50 に稼働）が作った DO ストレージが残っていた。

| ファイル | 作成時刻 | 中身 |
|---|---|---|
| `fog-state-UserDataDurableObject/acb3c048….sqlite` | 07:19 | `account` 1行（`status=active`, `created_at=1785709145852` = 07:19） |
| `fog-state-UserDataDurableObject/467d5ee5….sqlite` | 07:40 | `account` 1行（`status=active`, `created_at=1785710408598` = 07:40）、`_meta.self_locator = 019fc4a2-7385-7729-a3ea-20ae5db56d46` |
| `fog-state-IdentityDirectoryDurableObject/87fab7de….sqlite`, `c19e2043….sqlite` | 07:39 / 07:50 | Directory bucket 2件 |

現行プロセス（11:39 起動）はこの同じ state ディレクトリを再オープンしている（`metadata.sqlite` は 07:17 のまま、`metadata.sqlite-shm` が 11:39:38 に更新）。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | 前プロセスで作られた userId `019fc4a2-7385-7729-a3ea-20ae5db56d46` に対し、`.dev.vars` の `SESSION_SECRET` で `{typ:"session",uid,ep:0,exp}` の HMAC-SHA256 トークンを生成（`hmacSessionCodec.ts` と同一形式） | 有効なセッション cookie | 生成成功 | — |
| 2 | 別ブラウザセッションに `fog_session` として注入し `/settings` を開く | ログイン済みとして扱われ、アカウント情報が出る | `http://localhost:3000/settings` が 200 で描画。`main` = 「アカウント / 認証方式 / メールアドレスとパスワード / ログアウト」 | PASS |
| 3 | その DO の `_meta` を確認 | `schema_version` が据え置き | `schema_version=1` / `self_locator=019fc4a2-…`（作成時と同一。作り直されていない） | PASS |
| 4 | `migration_progress` を確認 | 部分適用が残っていない | 0行 | PASS |
| 5 | テーブル数を確認 | 16（AC-1） | 16（`sqlite_%` / `search_fts_%` / miniflare 内部を除外） | PASS |
| 6 | 該当時刻のサーバーログを確認 | スキーマ作成のログ・エラーが無い | 11:49 前後に DDL / `SQLITE_` / スタックトレースの出力なし | PASS |
| 7 | ファイルの mtime を確認 | 現行プロセスが実際に触っている | `467d5ee5….sqlite` の mtime が 11:49:36 に更新（アクセス時刻）。ファイル自体は 07:40 に作られたもの | PASS |

## 結論

- **DO の SQLite はプロセスをまたいで永続している。** 4時間前の別プロセスが作ったアカウントが、現行プロセスで**そのまま**ログイン状態として読める。`wrangler.state.toml` の `[exports.*] storage = "sqlite"` が効いており、インメモリにはなっていない。
- **migration ゲートは冪等に素通りしている。** 2回目以降の起動で `schema_version` が 1 のまま、`migration_progress` が空、テーブル数も 16 のままで、作り直しの痕跡が無い（AC-16 (iii)）。

## 未実施の部分（正直な記録）

- **手順1〜3 の「Ctrl-C → 再起動 → リロード」そのものは実行していない。** 上記は「別プロセスが作った DO を現行プロセスが読める」ことの確認であり、「セッション cookie が再起動をまたいで有効」という点は cookie がステートレス署名トークンである以上サーバー再起動と無関係なので、代替検証で十分カバーできていると判断した。
- 手順5 の「一度ログアウトして再ログイン」は TC-C04 で同一プロセス内では確認済み。前プロセス由来のアカウントについては、そのアカウントの平文メールアドレスが（設計上どこにも保存されていないため）不明で、ログインフォームから入力できないので未実施。
