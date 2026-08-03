# TC-C02: `wrangler types` が DO バインディングの型を生成し、D1 / Queue が消えている

**結果**: PASS（ただし testing.md の手順2・3 は前提が古い。下記「手順の前提のずれ」参照）
**対応する受け入れ基準**: AC-17 / AC-19

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `pnpm --filter @repo/web cf:types` | 再生成が成功する | exit 0。`✨ Types written to worker-configuration.d.ts`。生成された `__BaseEnv_Env` は `ASSETS` / `APP_URL` / `SESSION_SECRET` / `AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET` / `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY` / `USER_DATA` / `IDENTITY_DIRECTORY` の9件 | PASS |
| 2 | `git diff apps/web/worker-configuration.d.ts` | 差分なし | 差分なし。ただし**このファイルは追跡対象ではない**（`.gitignore:12` が `worker-configuration.d.ts` を無視）。したがってこの検査は空振りする | PASS（意味は薄い） |
| 3 | `grep -n "D1Database\|Queue<\|EVENTS_QUEUE" apps/web/worker-configuration.d.ts` | 0件 | **全文では6件ヒット**（1935 / 12122 / 12126 / 12130 / 12141 / 12147行）。すべて29行目 `// Begin runtime types` より後、すなわち workerd のランタイム API 宣言（`declare abstract class D1Database` / `interface Queue<Body>`）である。**バインディング宣言部（1〜28行）に限れば0件** | PASS（下記参照） |
| 4 | `grep -n "DurableObjectNamespace" apps/web/worker-configuration.d.ts` | `USER_DATA` / `IDENTITY_DIRECTORY` の2件を含む | 12行目 `USER_DATA: DurableObjectNamespace /* UserDataDurableObject from fog-state */;` / 13行目 `IDENTITY_DIRECTORY: DurableObjectNamespace /* IdentityDirectoryDurableObject from fog-state */;`。ともに `script_name = "fog-state"` の指定がコメントに反映されている | PASS |

## 手順の前提のずれ（テストケース側の問題）

### (a) このファイルは tracked ではない

testing.md は「tracked な生成物 `apps/web/worker-configuration.d.ts`」と書いているが、実際には `.gitignore:12` で無視されている（main の `d80fcf0 chore: … 生成物を ignore する` による）。したがって手順2 の「コミット漏れ検知」は成立しない。代わりに `@repo/web` の `postinstall` / `predev:cf` が `wrangler types` を走らせるので、`pnpm install` か `pnpm dev` を通れば必ず最新になる。

### (b) AC-17 の「`worker-configuration.d.ts` に `D1Database` / `Queue` が無い」は字義どおりには達成不能

`wrangler types` は workerd のランタイム型一式を同一ファイルへインライン展開する（本ファイル14721行のうち29行目以降がそれ）。この部分には `declare abstract class D1Database` と `interface Queue<Body = unknown>` が**バインディングの有無に関係なく**常に現れる。AC-17 が意図しているのはバインディング宣言（`__BaseEnv_Env`）側であり、そこは0件である。

**AC-17 の検証コマンドは行範囲を絞る必要がある。** 例:

```
sed -n '1,/^\/\/ Begin runtime types/p' apps/web/worker-configuration.d.ts | grep -n "D1Database\|Queue<\|EVENTS_QUEUE"
```

現状ではこの形で0件になる。

## 補足

`pnpm typecheck`（TC-C10）は再生成後の本ファイルを読んで exit 0 なので、`env.USER_DATA` / `env.IDENTITY_DIRECTORY` の型は実際に解決できている。
