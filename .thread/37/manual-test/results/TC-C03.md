# TC-C03: サインアップが通り、そのユーザーの Durable Object が作られる

**結果**: PASS
**対応する受け入れ基準**: AC-1 / AC-2 / AC-16

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/login` の「アカウント登録」から `/signup` を開く | 登録フォームが出る | `heading "アカウント登録"` / `textbox "メールアドレス" [required]` / `textbox "パスワード" [required]` / `button "登録する"` | PASS |
| 2 | `do-check@example.com` / `password123` を送信 | 登録成功 | 送信後 `http://localhost:3000/` へ遷移。`main` のテキストは「まだメモがありません」、`<title>` は「タイムライン」 | PASS |
| 3 | 送信中のボタン状態を観察（MutationObserver で記録） | pending 表示 + 二重送信不可 | 記録: `{text:"登録する", disabled:false}` → `{text:"登録中…", disabled:true}`。`useActionState` の pending が効いており submit が disabled になる | PASS |
| 4 | 遷移先を確認 | タイムライン `/` | `http://localhost:3000/`（「まだメモがありません」） | PASS |
| 5 | dev サーバーログを確認 | スタックトレース / `SQLITE_` エラーが無い | 該当時刻（11:42:37）前後に出たのは vite の `inputValidator() is deprecated` warning と TanStack Start の CSRF middleware 案内のみ。`SQLITE_` / スタックトレースは0件 | PASS |
| 6 | `apps/web/.wrangler/state/v3/do/` 配下を確認 | DO の SQLite ストレージが作られる | サインアップと同時刻（11:42:37）に**2ファイルが新規作成**された:<br>・`fog-state-UserDataDurableObject/6888c96a….sqlite`<br>・`fog-state-IdentityDirectoryDurableObject/dc8a394f….sqlite` | PASS |
| 7 | `pnpm db:migrate` を実行せずに成功したか | lazy migration が DDL を作る | 実行していない。それでも上記2 DO のスキーマが揃っている（下記） | PASS |

## DDL の実測（migration ゲートが初回 RPC で作ったもの）

作成された SQLite を read-only コピーして `sqlite_master` を列挙した。

**User Data DO** — `sqlite_%` / `search_fts_%`（FTS5 shadow 4件）/ miniflare 内部の `__miniflare_do_name` を除いた集合は**ちょうど16件**で AC-1 の列挙と一致:

```
account, ai_client_connections, credential_locators, document_revisions,
documents, jobs, memo_revisions, memos, migration_progress, operations,
search_entries, search_fts, source_links, topics, user_settings, _meta
```

shadow テーブル `search_fts_config` / `search_fts_data` / `search_fts_docsize` / `search_fts_idx` の4件が実在し、`search_fts_content` は無い（external-content の裏返し。AC-1 の「除外条件が空振りしていない」検査に対応）。

**Identity Directory DO** — 除外後**ちょうど5件**で AC-2 と一致:

```
credential_mappings, jobs, password_reset_tokens, rotation_checkpoints, _meta
```

**`_meta` の中身**（AC-16 のスキーマ版管理）:

| DO | `_meta` の行 |
|---|---|
| User Data | `1 | 019fc580-74f8-7100-ba6d-20ac519b2c9e`（schema_version = 1, DO 名 = `userId`） |
| Identity Directory | `1 | dir:g1:b6`（schema_version = 1, DO 名 = locator） |

DO 名も同じ値（miniflare の `__miniflare_do_name`）なので、**User Data DO は `idFromName(userId)`、Directory は `dir:g{gen}:b{index}`** という AC-3 の割り当て規則が実データで確認できた。

## 副次的に確認できたこと（AC-3）

サインアップ後の両 DO を `.dump` して `do-check@example.com` を grep した結果は**両方 0 件**。Directory 側は `hmac`（64桁 hex）と `encrypted_canonical` + `encryption_nonce` のみを持ち、生メールは保存されていない。

## 気づいた点（本ケースの合否には影響しない）

- サインアップ後の `credential_mappings` 行は `status='active'` / `user_id` 設定済みで saga は完走しているが、`reserved_until` に将来時刻（登録の約10分後）が残り `saga_committed` が空である。`sweep-reservations` ジョブが回収する設計なら正常だが、DB 単体からは判断できないので記録のみ。
- dev サーバーログに TanStack Start の「server functions are not protected by the CSRF middleware」警告が出る。#37 とは無関係（フレームワーク側の新警告）。
