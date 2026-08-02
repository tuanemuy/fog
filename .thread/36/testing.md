# 動作確認計画 — Issue #36: [実装] Node / AWS / GCP ランタイムを撤去する

**Issue:** #36
**作成日:** 2026-07-29

---

## 確認環境

このIssueの変更を確認するために必要な手順のみ記載する。

本 Issue の撤去により、**bare スクリプト（`pnpm dev` / `pnpm build` / `pnpm start` / `pnpm db:migrate` / `pnpm db:generate`）の既定が Cloudflare 構成に切り替わる**（plan.md ステップ8）。以下はすべて**撤去後**のコマンド体系で書いてある。ターゲットランタイムは **Cloudflare Workers + D1**（ローカルは `@cloudflare/vite-plugin` の workerd + ローカル D1）。

### 前提の準備

```bash
# 1. 依存を lockfile どおりに再インストール（撤去で lockfile が変わるため必須）
#    CI の3ジョブすべてが --frozen-lockfile を使う（plan.md ステップ16-1）
pnpm install --frozen-lockfile

# 2. wrangler が読むローカル秘密情報（未作成の場合のみ）
cp apps/web/.dev.vars.example apps/web/.dev.vars
openssl rand -base64 48     # 出力を apps/web/.dev.vars の SESSION_SECRET= に貼る（32文字以上）

# 3. ローカル D1 にマイグレーションを適用
#    = pnpm db:migrate:cf = wrangler d1 migrations apply tanstack-start-template-d1 --local
pnpm db:migrate
```

`SESSION_SECRET` は既定値を持たない（`.dev.vars.example` は空で出荷される）。空のままだと全リクエストが失敗するので、**確認項目2 以降に進む前に必ず設定する**。既に `apps/web/.dev.vars` を作成済みでシークレットが入っているなら手順2はスキップしてよい。

**マイグレーションは必要。** 本 Issue はスキーマに触らないが、libSQL（`apps/web/data/app.db`）から D1 へ既定が切り替わるため、ローカル D1 側にテーブルが無ければログインどころか登録もできない。適用済みなら `wrangler d1 migrations apply` は「no migrations to apply」で終わる（再実行して害はない）。

### 検証環境の起動

```bash
# 開発サーバー起動（= pnpm dev:cf = vite dev --config vite.config.cloudflare.ts）
# predev:cf の wrangler types が子プロセス側で自動発火する（plan.md ステップ8）
pnpm dev
```

起動後 `http://localhost:3000` を開く。

**`pnpm start`（= `start:cf` = `wrangler dev`）は動作確認に使わない。** 本 Issue 以前から起動できない — バンドルの生成自体は成功するが、`packages/core/src/application/workers/eventRelayWorker.ts:97` の module-scope `crypto.randomUUID()` により workerd が `Disallowed operation called within global scope.` で起動を拒否する（plan.md H-8 / リスク節、追跡は Issue #40）。`pnpm preview` も同一原因で使えない。確認項目8 でスクリプト定義の目視確認に置き換える。

### シードデータ

**不要。ただし検証用アカウントの作成が必要。** ローカル D1 は本 Issue の確認で初めて（あるいはマイグレーション適用直後の状態で）使うため、ユーザーが1件も無い前提で始める。`/signup` から検証用アカウントを1つ作り、以降の確認項目で使い回す（確認項目3 がその作成手順を兼ねる）。libSQL 側の `apps/web/data/app.db` に既存ユーザーがいても、D1 とは別のデータベースなので引き継がれない。

### デプロイ方法

**なし。** 本 Issue の確認はローカルで完結する。

- ステージング／本番の Wrangler 設定（`apps/web/wrangler.staging.toml` / `wrangler.production.toml`）は `.gitignore` 済みで、`pnpm cf:render:staging` / `pnpm cf:render:production` が Pulumi の出力からレンダリングする生成物であり、リポジトリには `.tpl` しか無い（実測: 両ファイルとも存在しない）。
- `pnpm deploy:staging*` / `pnpm deploy:production*` は D1 / Cloudflare 側のスクリプトで **本 Issue では1つも変更しない**（plan.md スコープ「含まれないもの」— #37 の担当）。撤去で削除するのは `pnpm deploy:aws:*` の4本だけで、これは `infra/aws` ごと消えるため実行対象そのものが無くなる。

---

## 確認項目

### 1. 撤去後の依存構成で `pnpm install --frozen-lockfile` が通る

- **対応する受け入れ基準:** AC-2 / AC-9
- **目的:** ワークスペースメンバー（`infra/aws`）と9依存の削除後も lockfile とマニフェストが整合し、CI が使う `--frozen-lockfile` で落ちないことを確認する
- **手順:**
  1. リポジトリルートで `pnpm install --frozen-lockfile` を実行する
  2. 続けて `pnpm --filter @repo/web exec wrangler types` が `postinstall` で走り切っていることを出力で確認する
- **期待結果:** exit 0 で完了する。`ERR_PNPM_OUTDATED_LOCKFILE` が出ない。`postinstall` の `wrangler types` が `apps/web/worker-configuration.d.ts` を再生成して成功する
- **確認ポイント:** `infra/aws` を `pnpm-workspace.yaml` から外し忘れると「ワークスペースは無いのにエントリがある」でここが落ちる。`pnpm install`（frozen なし）だけで済ませず、**必ず lockfile をコミットしてから `--frozen-lockfile` を実行する**（plan.md ステップ16-1）

### 2. 未認証のトップページが Cloudflare 構成の dev サーバーでログイン画面に誘導される

- **対応する受け入れ基準:** AC-3
- **目的:** `pnpm dev` の既定が Cloudflare 構成（workerd）に切り替わったうえで、アプリが従来どおり起動して認証ガードが効くことを確認する
- **手順:**
  1. `pnpm dev` を実行し、起動ログに `vite.config.cloudflare.ts` が使われていることを確認する
  2. シークレットウィンドウで `http://localhost:3000/` を開く
  3. 別ターミナルで `curl -i http://localhost:3000/` も実行する
- **期待結果:** ブラウザではログイン画面（見出し「ログイン」、メールアドレス／パスワード欄、「ログイン」ボタン）が描画される。`curl` は `HTTP/1.1 307` と `location: /login` を返す
- **確認ポイント:** **307 は正常**（`apps/web/app/routes/_app.tsx` の `beforeLoad` が `/login` へリダイレクトする既存挙動。HEAD でも同じ 307 を返すことを実測済み）。撤去による退行と誤認しないこと。逆に 500 やビルドエラーが出る場合は、削除したモジュールへの import 残りを疑う

### 3. アカウント登録からログインまでが従来どおり動く

- **対応する受け入れ基準:** AC-3 / AC-7（撤去後の回帰確認）
- **目的:** D1 への書き込み・パスワードハッシュ（`webcrypto/pbkdf2PasswordHasher`）・セッション Cookie（`webcrypto/hmacSessionCodec`）が、JSDoc 編集後も実際に動くことを確認する
- **手順:**
  1. `http://localhost:3000/login` の「アカウント登録」リンクから `/signup` を開く
  2. メールアドレス `cf-check@example.com` / パスワード `password123` を入力して送信する
  3. 登録完了後の遷移先を確認する
  4. 設定画面（確認項目5）でログアウトし、`/login` から同じ資格情報でログインし直す
- **期待結果:** 登録が成功してタイムライン（`/`、「まだメモがありません」）に遷移する。ログアウト後の再ログインも成功して同じ画面に戻る
- **確認ポイント:**
  - 送信中にボタンが pending 表示になり、フォームが二重送信されないこと（`useActionState`）
  - 登録済みメールで再度登録しようとしたときにフォーム内にエラーメッセージが出ること（エラーの直列化経路が生きている）
  - `packages/core/src/adapters/webcrypto/` は JSDoc しか触らないので**挙動は変わらないのが正**。ここが壊れたら編集で実装に手が入っている

### 4. グローバルナビの5画面がすべて表示・遷移できる

- **対応する受け入れ基準:** AC-3 / AC-7（撤去後の回帰確認）
- **目的:** 撤去後もルーティングとアプリシェルが無傷であることを、実在する全画面で確認する
- **手順:**
  1. ログイン済みの状態でビューポート幅 1280px（lg 以上）にする
  2. 左サイドバーの「タイムライン」→「トピック」→「検索」→「ゴミ箱」→「設定」を順にクリックする
  3. ビューポート幅 390px に変え、ヘッダー右の「メニュー」ボタンからナビシートを開いて同じ5項目を順に開く
  4. 各画面でブラウザリロード（SSR 経路）も行う
- **期待結果:** `/` は「まだメモがありません」、`/topics` `/search` `/trash` は「準備中です」、`/settings` はアカウント情報が表示される。ヘッダーのタイトルとブラウザタブのタイトルが各画面のラベル（タイムライン／トピック／検索／ゴミ箱／設定）に追随する。リロードでも同じ内容が出る
- **確認ポイント:** クライアント遷移だけでなく**リロードによる SSR 経路**も必ず通すこと — workerd 上の SSR は `pnpm dev` の既定が切り替わって初めて日常的に通る経路になる。ナビシートは Escape とオーバーレイクリックで閉じること

### 5. 設定画面がスケルトンから実データへストリーミングされ、ログアウトできる

- **対応する受け入れ基準:** AC-3 / AC-7（撤去後の回帰確認）
- **目的:** サーバー関数 → RSC ストリーミング → クライアント島（`useTransition`）という3層が、Cloudflare 構成の dev サーバーで通しで動くことを確認する
- **手順:**
  1. DevTools の Network で通信を「Slow 4G」相当に絞る
  2. タイムラインから左ナビで `/settings` へ遷移する
  3. スケルトン → 実データの差し替わりを観察する
  4. 表示された「メールアドレス」が確認項目3 で登録したアドレス、「認証方式」が「メールアドレスとパスワード」であることを確認する
  5. 「ログアウト」ボタンを押す
- **期待結果:** 先にスケルトンが出て、その後アカウント情報にレイアウトシフトなく差し替わる。ログアウトすると `/login` に遷移する
- **確認ポイント:**
  - ログアウト中にボタンが「ログアウト中…」になり、disabled になること
  - ログアウト後に**ブラウザバックで `/settings` に戻れない**こと（`staleTime: 0` + `replace: true`）
  - `serverData` 経由の `getCurrentUser` は D1 リポジトリを叩く。ここが 500 になるならマイグレーション未適用を疑う

### 6. `pnpm db:migrate` の既定が D1 を指している

- **対応する受け入れ基準:** AC-3 / AC-4
- **目的:** bare の DB スクリプトが削除済みの Node スクリプト（`tsx scripts/migrate.node.ts`）を指し続けていないことを、実行して確認する
- **手順:**
  1. `pnpm db:migrate` を実行する
  2. `pnpm db:generate` を実行する
  3. `apps/web/package.json` の `db:migrate` / `db:generate` の定義を目視で確認する
- **期待結果:** `pnpm db:migrate` が `wrangler d1 migrations apply tanstack-start-template-d1 --local` として走り、適用済みなら「no migrations to apply」で正常終了する。`pnpm db:generate` が `drizzle.config.ts`（D1 用）で走り、スキーマ無変更なら新しい SQL を生成しない。定義はそれぞれ `pnpm db:migrate:cf` / `pnpm db:generate:cf` のエイリアスになっている
- **確認ポイント:** `tsx: command not found` や `Cannot find module 'scripts/migrate.node.ts'` が出たら、エイリアスの張り替え漏れ。`db:generate` が `packages/core/src/adapters/d1/migrations/` 以外に書き出していないこと（`drizzle.libsql.config.ts` は削除済み）

### 7. `pnpm build` が Cloudflare 構成で完了する

- **対応する受け入れ基準:** AC-3 / AC-7
- **目的:** bare の `build` が `vite.config.cloudflare.ts` を指し、撤去した依存を参照せずにビルドが通ることを確認する
- **手順:**
  1. `pnpm build` を実行する
  2. 出力に `vite.config.cloudflare.ts` が使われていることと、生成物のパスを確認する
- **期待結果:** ビルドが成功し `apps/web/dist/server/index.js` が生成される（HEAD の実測では 735.68 kB）
- **確認ポイント:** `Rolldown failed to resolve import "drizzle-orm/d1"` が出た場合は撤去の失敗ではなく `node_modules` が `package.json` と乖離している（確認項目1 の `pnpm install --frozen-lockfile` をやり直す）。`@libsql/client` / `@aws-sdk/*` / `@google-cloud/*` の解決エラーが出たら、それは本物の撤去漏れ

### 8. `pnpm start` のスクリプト定義が Cloudflare 構成を指している（実行しない）

- **対応する受け入れ基準:** AC-3
- **目的:** 実行検証できない `start` について、定義だけが正しく切り替わっていることを確認する
- **手順:**
  1. `apps/web/package.json` の `"start"` と `"start:cf"` を目視で確認する
  2. ルート `package.json` の `"start"` の委譲先を目視で確認する
  3. `"start:node"` / `"start:gcp"` が両方の `package.json` から消えていることを確認する
- **期待結果:** `apps/web` は `"start": "pnpm start:cf"` / `"start:cf": "wrangler dev"`、ルートは `"start": "pnpm --filter @repo/web start"`。`start:node` / `start:gcp` は残っていない
- **確認ポイント:** **`pnpm start` は実行しないこと。** 本 Issue 以前から `wrangler dev` は起動できない。⚠️ **当初ここに書いていた原因（`wrangler.toml:13` の `main` が TS ソースを指しており esbuild が `#tanstack-router-entry` 等を解決できない）は誤診断で、訂正済み。** 正しくはビルドは成功し（実測 78 modules / 1132.07 KiB）、`packages/core/src/application/workers/eventRelayWorker.ts:97` の module-scope `crypto.randomUUID()` により **workerd の起動時**に `Disallowed operation called within global scope.` → `The Workers runtime failed to start.` で落ちる。実行して失敗しても本 Issue の退行ではない（plan.md H-8 / Issue #40 https://github.com/tuanemuy/fog/issues/40 ）

### 9. 静的検査・テストがすべて green で、件数が想定どおり減る

- **対応する受け入れ基準:** AC-7
- **目的:** 撤去でテストが「消えた」のではなく「Node 側の分だけ減った」ことを、HEAD のベースラインとの差で確認する
- **手順:**
  1. `pnpm typecheck` を実行する
  2. `pnpm lint` / `pnpm format:check` を実行する
  3. `pnpm test:unit` を実行し、files / tests の件数を控える
  4. `pnpm test:integration` を実行し、files / tests の件数を控える
- **期待結果:**

  | コマンド | HEAD のベースライン | 撤去後の期待値 |
  |---|---|---|
  | `pnpm typecheck` | exit 0（4 ワークスペース） | exit 0（**3 ワークスペース**。`@repo/infra-aws` が消える） |
  | `pnpm lint` | exit 0 | exit 0 |
  | `pnpm format:check` | exit 0 | exit 0 |
  | `pnpm test:unit` | 26 files / 424 tests | `packages/core/src/adapters/node/__tests__/` の**2ファイル分だけ**減る（24 files） |
  | `pnpm test:integration` | `:node` + `:cf` の2本立て | **`:cf` 単独**になり 9 files / **104 tests**（HEAD の `pnpm test:integration:cf` と同数） |

- **確認ポイント:**
  - `pnpm test:integration` が `test:integration:node` を呼ぼうとして落ちないこと（ルートの `test:integration` は `"pnpm test:integration:cf"` のエイリアスになる）
  - 統合テストの 104 件は**1件も減らないのが正**。減っていたら `vitest.config.integration.ts` の `exclude` を消しすぎている
  - unit が2ファイル以上減っていたら、Cloudflare 側のテストを巻き添えで消している

---

## エッジケース・異常系

### 1. 未認証で保護画面を直接開くと `?redirect=` 付きでログインに飛ばされ、ログイン後に戻る

- **目的:** リダイレクト往復（`toSafeRedirect` / `redirectSearchSchema`）が撤去後も動くことを確認する
- **手順:**
  1. シークレットウィンドウで `http://localhost:3000/settings` を直接開く
  2. 遷移先の URL を確認する
  3. 確認項目3 の資格情報でログインする
- **期待結果:** `/login?redirect=%2Fsettings` に飛び、ログイン成功後は `/` ではなく `/settings` に戻る

### 2. 存在しないパスで 404 画面が出る

- **目的:** ルーターの not-found 経路が撤去の巻き添えを受けていないことを確認する
- **手順:**
  1. `http://localhost:3000/no-such-page` を開く
- **期待結果:** 「ページが見つかりません」の画面が表示され、「タイムラインへ」のリンクから `/` に戻れる

### 3. 誤ったパスワードでログインするとフォーム内にエラーが出る

- **目的:** アプリケーション層のエラーがサーバー関数境界で直列化され、UI まで届く経路が生きていることを確認する
- **手順:**
  1. `/login` で確認項目3 のメールアドレス + 誤ったパスワードを送信する
- **期待結果:** 画面遷移せずフォーム内にエラーメッセージが表示され、該当フィールドにフォーカスが移る。500 画面やスタックトレースは出ない
- **確認ポイント:** ここで英語の生の例外文言が出る場合、`presentation/` のエラー直列化に手が入っている（本 Issue では `presentation/` は**1行も触らないのが正**）

### 4. `SESSION_SECRET` が未設定だとリクエストが失敗する

- **目的:** `application/di/secrets.ts` の JSDoc を書き換えても、per-request の秘密情報チェック自体は無変更であることを確認する
- **手順:**
  1. `apps/web/.dev.vars` の `SESSION_SECRET` を一時的に空にして `pnpm dev` を再起動する
  2. `http://localhost:3000/login` を開く
  3. 確認後、値を戻して再起動する
- **期待結果:** リクエストがエラーになる（起動時ではなく**リクエスト時**に落ちるのが Cloudflare の正しい挙動 — boot フェーズで `env` が存在しないため config は必然的に per-request）
- **確認ポイント:** 「Node / AWS / GCP は boot 時に落ちる」という対比はステップ5 で JSDoc から消える。挙動として残るのは per-request 側だけ

---

## 既存機能への影響確認

- **セッションの永続** — ログイン後にブラウザをリロードしても、また別タブで `http://localhost:3000/settings` を開いてもログイン状態が維持されること（`hmacSessionCodec` は JSDoc しか触らないので挙動は変わらないのが正）。
- **レスポンシブ表示** — 1280px（サイドバー）と 390px（ヘッダー + ナビシート）の両方で確認項目4・5 を通すこと。本 Issue は CSS に一切触らないので、見た目が変わっていたら別の原因。
- **outbox / relay のローカル挙動** — アカウント登録は outbox 行を書く（`collectEvents`）。ローカル dev では `wrangler.toml` の `[[services]]` が指す relay Worker が起動していないため Service Binding の kick が失敗しうるが、**失敗はログに出して握り潰す設計**（`wrangler.toml` のコメント）なので、UI 上のエラーにならなければ正常。relay / consumer / pruner / dlq の Worker 自体は本 Issue で**無変更**（#37 の担当）。
- **`.dev.vars` / `wrangler.toml` を壊していないこと** — `pnpm dev` の `predev:cf` で `wrangler types` が走るので、`wrangler.toml` を壊すとここで即座に落ちる。確認項目2 が通っていればこの経路も担保されている。
- **撤去漏れの機械的チェック** — ブラウザ確認とは別に、plan.md ステップ16 の 9.（全文検索・現状 79 ファイル → 0件）/ 10.（`package.json` 3件と lockfile `importers:` → 0件）/ 11.（`git diff --stat main...HEAD` による層分離検証）/ 12.（`.github/workflows/ci.yml` 専用 grep・現状6行 → 0件）を実行する。ブラウザ操作では検出できない残骸はこちらで潰す。
