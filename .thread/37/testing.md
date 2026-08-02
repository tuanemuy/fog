# 動作確認計画 — Issue #37: [実装] D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

**Issue:** #37
**作成日:** 2026-08-03

---

## この計画の射程

**AC 30項目の大半は自動テストが担保する。** 本ファイルが扱うのは「**ブラウザで実際に触らないと分からないこと**」だけである。

- **自動テスト側の担保（本ファイルでは確認しない）** — job table の CAS / backoff / poison / lease reclaim、Alarm の起動セマンティクス（AC-12 / AC-13）、`purge-trash` の2フェーズ（AC-10）、`send-mail` の enqueue → 実行 → 完了 E2E（AC-11）、FTS5 の同一トランザクション projection と trigram / bm25（AC-7 / AC-9）、migration ゲートと fail-closed（AC-16）、OCC の誤帰属不在（AC-6）、前方互換点（AC-27）。**これらは UI を持たない**（検索・ゴミ箱・トピックの各画面は `準備中です` のプレースホルダ、保持期限の変更 UI は #11、パスワードリセット完了は #12）ので、ブラウザからは起動できない。
- **本ファイルが確認するもの** — **現在 UI が存在する動線が DO 移行後も動くこと**（サインアップ / ログイン / ログアウト / セッション維持 / 設定画面 / ナビゲーション）と、**ローカル実行そのものの成立**（2 Worker 構成での起動、`pnpm start` の起動可否、ビルド成果物の起動）である。

実測した現在の UI 動線は次のとおり（`apps/web/app/routes/` を通読）。

| ルート | 実体 |
|---|---|
| `/login` / `/signup` | 実装済み（`LoginForm` / `SignupForm`。`useActionState`） |
| `/settings` | 実装済み（RSC ストリーミング + `LogoutButton` の `useTransition`） |
| `/`（タイムライン） | プレースホルダ（「まだメモがありません」） |
| `/topics` / `/search` / `/trash` | プレースホルダ（「準備中です」） |
| `/password-reset` | プレースホルダ（「この機能は準備中です」。トークン発行の**バックエンド**は #37 で実装するが、起動する UI は無い） |

---

## 確認環境

このIssueの変更を確認するために必要な手順のみ記載する。**#37 はスクリプト体系を大きく入れ替えるので、以下はすべて実装完了後のコマンドで書いてある。** 出典を各所に明記した — 「実測」は現行リポジトリの `package.json` / `README.md` を読んだもの、「steps.md ステップN」は #37 で新設・改名されるものである。

### 前提の準備

```bash
# 1. 依存を lockfile どおりに再インストール
#    #37 は drizzle-orm / drizzle-kit を削除し（steps.md ステップ19）、
#    miniflare を devDependency に足す（同ステップ24）ので lockfile が必ず変わる。
#    CI は3ジョブとも --frozen-lockfile（実測 .github/workflows/ci.yml）。
pnpm install --frozen-lockfile

# 2. wrangler が読むローカル秘密情報
#    .dev.vars.example は steps.md ステップ26 で5エントリへ書き換わる。
cp apps/web/.dev.vars.example apps/web/.dev.vars
openssl rand -base64 48     # SESSION_SECRET に貼る（32文字以上）
openssl rand -base64 48     # AI_CLIENT_TOKEN_SECRET に貼る
```

`.dev.vars` に入れる値は **request 側3つ / state 側2つ**で、配布境界は非重複である（steps.md ステップ26 が `.dev.vars.example` のコメントに明示すると決めている）。

| 変数 | 配布先 | 形 |
|---|---|---|
| `SESSION_SECRET` | request Worker | 単一鍵（32文字以上） |
| `AI_CLIENT_TOKEN_SECRET` | request Worker | 単一鍵（32文字以上。器だけ用意し実体化は #13） |
| `DIRECTORY_ROUTING_SECRET` | request Worker | **JSON keyring**（`{ generation, key, bucketCount }` の配列） |
| `IDENTITY_MAIL_ENCRYPTION_KEY` | state Worker | JSON keyring |
| `IDENTITY_RESET_TOKEN_KEY` | state Worker | JSON keyring |

**keyring 3本は `.dev.vars.example` に書かれる例をそのまま使う。** 構築時に (i) `generation` の一意性、(ii) `active` がちょうど1件、(iii) `previous` が0〜1件、(iv) `DIRECTORY_ROUTING_SECRET` は各エントリの `bucketCount >= 1` を検査し、**検査を通らない値では起動時点ではなくリクエスト時に失敗する**（steps.md ステップ17）。自分で書くなら例の形を崩さないこと。

**`pnpm db:migrate` は実行しない — このスクリプトは #37 で消える。** `db:*` 10本（ルート・`@repo/web` の両方で20本）が削除され（steps.md ステップ26 / AC-18）、**DO の SQLite スキーマは migration ゲートが最初の RPC で作る**（AC-16）。つまり「マイグレーションを先に流す」手順そのものが無くなる。**初回サインアップが、そのユーザーの User Data DO で DDL が走る最初の瞬間である**（確認項目3 がこれを兼ねる）。

### 検証環境の起動

**#37 以降、ローカルは2 Worker 構成になる。** request Worker（`apps/web/app/server.cloudflare.ts`）の DO バインディングは `script_name = "fog-state"` で state Worker のクラスを指す（steps.md ステップ25 のローカル `wrangler.toml`）。

```bash
# ターミナル1 — state Worker（DO クラスを持つ側）
#   steps.md ステップ26 で新設されるスクリプト = wrangler dev -c wrangler.state.toml
pnpm dev:state

# ターミナル2 — request Worker（アプリ本体）
#   実測: root の dev → @repo/web dev → dev:cf → vite dev --config vite.config.cloudflare.ts
#   #37 はこのスクリプトを変更しない
pnpm dev
```

起動後 `http://localhost:3000` を開く（実測: `README.md` の Quick Start と `.thread/36/testing.md` がこのポートを使っている）。

> **確認事項（断定しない）:** `pnpm dev` 単独で `script_name` 付きの DO バインディングが解決できるかは、実装するまで確定しない。`@cloudflare/vite-plugin` が dev registry 経由で別プロセスの `wrangler dev` を見つける形になるはずだが、#37 の計画はそれを前提として書いていない。**確認項目1 でどちらが必要かを実際に確かめ、結果を PR 本文に1行残すこと。** `pnpm dev` 単独で通るならターミナル1 は不要になる。

**`pnpm start`（= `start:cf` = `wrangler dev`）は #37 で起動できるようになる可能性がある。** 現在の起動不能は `packages/core/src/application/workers/eventRelayWorker.ts` の module-scope `crypto.randomUUID()` が原因で（`CLAUDE.md` / `README.md` / Issue #40）、**このファイルは steps.md ステップ12 でディレクトリごと削除される。** steps.md ステップ29 も「`pnpm start` / `pnpm preview` が起動不能」の記述を `CLAUDE.md` から削除すると決めている。ただし削除の根拠として要求されているのは**スモークテストが緑であること**であって、`wrangler dev` が実際に上がることではない。**確認項目9 で実際に起動を試し、結果を記録する。**

### デプロイ方法

**#37 の確認範囲は `--dry-run` までである。実デプロイは行わない。**

理由（plan.md リスク欄が根拠）: `Pulumi.{staging,production}.yaml` が `REPLACE_WITH_CF_ACCOUNT_ID` のままでどのスタックも `up` されていないため、`pnpm cf:render:staging` が参照する Pulumi 出力が存在しない。デプロイワークフローそのものは #21 / #24、運用手順は #38 の担当である（plan.md スコープ節）。

```bash
# ローカル設定に対する dry-run（steps.md ステップ25 / ステップ32 項目9）
cd apps/web
npx wrangler deploy -c wrangler.toml       --dry-run --outdir=/tmp/req-dry
npx wrangler deploy -c wrangler.state.toml --dry-run --outdir=/tmp/state-dry
```

ステージング設定をレンダリングできる環境（Pulumi スタックが `up` 済み）が手に入った場合のみ、次が使える（steps.md ステップ25 / ステップ26）。

```bash
pnpm cf:render:staging          # wrangler.request.staging.toml と wrangler.state.staging.toml の2本を出す
pnpm deploy:staging:dry         # = deploy:state:staging:dry && deploy:request:staging:dry
pnpm deploy:staging             # = deploy:state:staging && deploy:request:staging（state が先）
```

新 `deploy:*` は片側12本（役割別 `deploy:{request,state}:{staging,production}{,:dry}` の8本 + 合成 `deploy:{staging,production}{,:dry}` の4本。AC-18 / steps.md ステップ26）。**`deploy:*:{relay,consumer,pruner,dlq}` は対象消滅**（Worker ごと削除）。

---

## 確認項目

### 1. 2 Worker 構成でローカルが起動し、未認証がログイン画面へ誘導される

- **対応する受け入れ基準:** AC-19 / AC-29
- **目的:** D1 / Queue バインディングを外し DO バインディングへ差し替えたローカル `wrangler.toml` / `wrangler.state.toml` で、アプリが起動して認証ガードが効くことを確認する。**あわせて「`pnpm dev` 単独で足りるのか、`pnpm dev:state` の併走が要るのか」をここで確定させる。**
- **手順:**
  1. **まず `pnpm dev` だけを起動し**、`http://localhost:3000/` をシークレットウィンドウで開く
  2. `curl -i http://localhost:3000/` も実行する
  3. 1 が失敗する（DO バインディングを解決できないエラーが出る）場合は、別ターミナルで `pnpm dev:state` を起動してから `pnpm dev` をやり直す
  4. どちらの構成で通ったかを記録する
  5. `pnpm dev` の起動ログに `wrangler types`（`predev:cf`）が走り切っていること、D1 / Queue に関するエラーが出ていないことを確認する
- **期待結果:** ログイン画面（見出し「ログイン」、メールアドレス／パスワード欄、「ログイン」ボタン）が描画される。`curl` は `HTTP/1.1 307` と `location: /login` を返す
- **確認ポイント:**
  - **307 は正常**（`apps/web/app/routes/_app.tsx` の `beforeLoad` によるリダイレクト。既存挙動）
  - `Cannot find binding "USER_DATA"` / `no such D1 database` の類が出たら、ローカル `wrangler.toml` の差し替え漏れ（steps.md ステップ25）を疑う
  - **ローカル `wrangler.toml` の `main` は `app/server.cloudflare.ts`（ソースエントリ）のままが正しい**（成果物を指すと `@cloudflare/vite-plugin` が throw する。plan.md リスク欄の実測）。ここが `dist/server/index.js` になっていると、クリーンな clone でそもそも起動しない

### 2. `wrangler types` が DO バインディングの型を生成し、D1 / Queue が消えている

- **対応する受け入れ基準:** AC-17 / AC-19
- **目的:** tracked な生成物 `apps/web/worker-configuration.d.ts` が新構成で再生成されていることを確認する。**このファイルは AC-17 / AC-19 の grep もステップ19 の grep も射程外なので、古い D1 型が残っても機械検証では気づけない**（steps.md ステップ25）
- **手順:**
  1. `pnpm --filter @repo/web cf:types` を実行する
  2. `git diff apps/web/worker-configuration.d.ts` で差分が出ないことを確認する
  3. `grep -n "D1Database\|Queue<\|EVENTS_QUEUE" apps/web/worker-configuration.d.ts` を実行する
  4. `grep -n "DurableObjectNamespace" apps/web/worker-configuration.d.ts` を実行する
- **期待結果:** 3 が 0 件。4 が `USER_DATA` / `IDENTITY_DIRECTORY` の2件を含む。2 で差分が出ない（コミット済みの生成物が最新である）
- **確認ポイント:** 差分が出るならコミット漏れ。`pnpm typecheck`（確認項目10）はこのファイルを読むので、ここが古いと `env.USER_DATA` で落ちる

### 3. サインアップが通り、そのユーザーの Durable Object が作られる

- **対応する受け入れ基準:** AC-1 / AC-2 / AC-16
- **目的:** signup saga（phase 0〜4）が request Worker → Identity Directory DO → User Data DO を跨いで完走し、**その過程で migration ゲートが両 DO の DDL を初回作成する**ことを、実際の画面操作で確認する。#37 で最も配線が長い経路である
- **手順:**
  1. `http://localhost:3000/login` の「アカウント登録」リンクから `/signup` を開く
  2. メールアドレス `do-check@example.com` / パスワード `password123` を入力して送信する
  3. 送信中のボタンの状態を観察する
  4. 遷移先を確認する
  5. `pnpm dev` / `pnpm dev:state` の**両方のターミナルログ**を確認する
  6. `ls -la apps/web/.wrangler/state/` 配下に DO の SQLite ストレージが作られていることを確認する
- **期待結果:** 登録が成功してタイムライン（`/`、「まだメモがありません」）に遷移する。ログにスタックトレースや `SQLITE_` 系のエラーが出ない
- **確認ポイント:**
  - 送信中にボタンが pending 表示になり二重送信されないこと（`useActionState`。既存挙動が壊れていないこと）
  - **初回リクエストがスキーマ作成を含むので、2回目以降より遅くて正常**（lazy migration。AC-16）
  - **`pnpm db:migrate` を実行していないのに成功するのが正しい。** 「テーブルが無い」で落ちるなら migration ゲートが RPC エントリの先頭に入っていない
  - **ログに生のメールアドレス・HMAC 全長値・`dir:g0:b*` の locator が出ていないこと**（AC-3。確認項目7 で本格的に見るが、ここでも一度目を通す）

### 4. ログアウトしてから同じ資格情報でログインできる

- **対応する受け入れ基準:** AC-2 / AC-4
- **目的:** **正規化メールから `userId` を解決する読み経路**（`Email.create` の canonical 化 → `directoryLocator.forCanonical` → `lookupCredential(kind, hmac)`）と、到達性検査つきの `verifyLogin` が実際に動くことを確認する
- **手順:**
  1. 確認項目3 の状態から `/settings` へ移動し、「ログアウト」ボタンを押す
  2. `/login` で `do-check@example.com` / `password123` を送信する
  3. **大文字混じり**（`DO-Check@Example.com`）でもログインできることを確認する
  4. 前後に空白を入れた入力（` do-check@example.com `）でも同じく通ることを確認する
- **期待結果:** 3回ともログインに成功してタイムラインに戻る。canonical 化（local 部の lowercase / domain 部の NFKC + lowercase / `trim()`）が効いているので、同じ mapping 行に解決する
- **確認ポイント:**
  - **3 と 4 が通らない場合、canonical 化がドメイン層と DO 側で食い違っている**（`Email.create` の順序が steps.md ステップ13 のとおりか確認する）
  - ログアウト後に**ブラウザバックで `/settings` に戻れない**こと（`staleTime: 0`。既存挙動）
  - ログアウトで `sessionEpoch` は進めないのが正（steps.md の usecase 表）

### 5. 設定画面がスケルトンから実データへストリーミングされる

- **対応する受け入れ基準:** AC-1 / AC-4
- **目的:** `getCurrentUser` が **User Data DO の RPC 経由**（`userDataStubFactory(userId).getCurrentUser(userId, epoch)`）に変わったあとも、サーバー関数 → RSC ストリーミング → クライアント島という3層が通しで動くことを確認する
- **手順:**
  1. DevTools の Network を「Slow 4G」相当に絞る
  2. タイムラインから左ナビで `/settings` へ遷移する
  3. スケルトン → 実データの差し替わりを観察する
  4. 表示された「メールアドレス」が確認項目3 で登録したアドレスであることを確認する
  5. ページをリロードして SSR 経路でも同じ内容が出ることを確認する
- **期待結果:** 先にスケルトン（`SettingsSkeleton`）が出て、その後アカウント情報に**レイアウトシフトなく**差し替わる
- **確認ポイント:**
  - **`CurrentUserView` の形が変わっている** — `authMethod` が落ち、`credentials`（`credentialId` / `kind` / `usableForLogin` / `label`）が入る（steps.md ステップ18）。画面の表示項目が #37 の範囲で変わる唯一の場所なので、**`CurrentUserPanel` が新しい形を読めているか**を目視で確認する
  - ここが 500 になるなら stub factory の組み立て（steps.md ステップ17）か epoch ガードを疑う。**「マイグレーション未適用」は原因になりえない**（もう存在しない概念）

### 6. dev サーバーを再起動してもアカウントとセッションが残る

- **対応する受け入れ基準:** AC-1 / AC-16
- **目的:** DO の SQLite が**プロセスをまたいで永続**しており、2回目以降の起動では migration ゲートが冪等に素通りすることを確認する。「毎回スキーマを作り直している」という失敗を検出する
- **手順:**
  1. ログイン済みの状態で `pnpm dev`（と `pnpm dev:state`）を Ctrl-C で止める
  2. 同じコマンドで起動し直す
  3. ブラウザをリロードする
  4. ログイン状態が維持されていることを確認する
  5. 一度ログアウトし、同じ資格情報で再ログインできることを確認する
- **期待結果:** リロード後もログイン済みのまま `/`（または最後にいた画面）が表示される。再ログインも成功する
- **確認ポイント:**
  - **再起動後に「アカウントが無い」状態になるなら、DO のストレージがインメモリになっている**（`wrangler.state.toml` の `[exports.*]` の `storage = "sqlite"` を確認する）
  - `apps/web/.wrangler/state/` を消してから起動すると当然データも消える。**確認項目3 をやり直す前提でのみ消すこと**
  - 2回目の起動でスキーマ作成のログ／遅延が出ないこと（ゲートの冪等性。AC-16 (iii)）

### 7. 秘密と PII が URL・画面・ログのどこにも出ない

- **対応する受け入れ基準:** AC-3
- **目的:** DO の locator（`dir:g{gen}:b{index}`）・HMAC 全長値・canonical メール・`callerToken` などが、**人間の目に触れる経路**に漏れていないことを確認する。unit テスト（`noSecretLogging.test.ts`）はフェイク Logger を通る経路しか見ないので、**実際の画面と実際のログを見る意味がある**
- **手順:**
  1. 確認項目3〜5 を一巡したあと、`pnpm dev` / `pnpm dev:state` の**両方のターミナル出力を全文**確認する
  2. ブラウザの URL バーを、サインアップ・ログイン・設定の各遷移で確認する
  3. DevTools の Network で、各サーバー関数呼び出し（`/_serverFn/...`）の**レスポンスボディ**を確認する
  4. わざとログインに失敗させ（誤ったパスワード）、その**エラーレスポンス**も同じく確認する
  5. `document.cookie` をコンソールで確認する
- **期待結果:** 次のいずれも**どこにも現れない** — 生のメールアドレス以外の canonical 表現 / `dir:g0:b*` 形式の locator / 64桁 hex の HMAC / `callerToken` / `changeAuthToken` / `passwordVerifier` / リセットトークン
- **確認ポイント:**
  - **セッション cookie の中身は `{ typ, uid, ep, exp }` の署名付きトークン**で、メールアドレスを含まないこと（steps.md ステップ17）
  - エラーレスポンスに DO 側の内部詳細（`SQLITE_...` / `Durable Object ...`）が生で出ていないこと。出るなら `platform/stubErrors.ts` の翻訳を通っていない
  - **`userId` が URL に出るのは設計上ありうる**が、locator は出てはならない。混同しないこと

### 8. ビルド成果物が workerd で起動する（request / state の両方）

- **対応する受け入れ基準:** AC-22 / AC-23
- **目的:** `build:cf` の2段化（steps.md ステップ6）で `dist/state/index.js` が出ること、およびスモークテストが**実際に module scope 制約違反を検知できる**ことを確認する。型検査・lint・統合テストのいずれも #40 を検知できなかったので、**検知力そのものを一度確かめる**
- **手順:**
  1. `rm -rf apps/web/dist && pnpm build:cf` を実行する
  2. `ls -la apps/web/dist/server/index.js apps/web/dist/state/index.js` で両方の存在を確認する
  3. `pnpm test:smoke` を実行する
  4. `apps/web/app/worker/cloudflare/state.ts` の module スコープに `const _probe = crypto.randomUUID();` を1行足し、`pnpm build:cf && pnpm test:smoke` をやり直す
  5. その1行を戻し、もう一度 `pnpm build:cf && pnpm test:smoke` が緑になることを確認する
- **期待結果:** 1〜3 が成功。**4 で赤になる**（`Disallowed operation called within global scope` を検知する）。5 で緑に戻る
- **確認ポイント:**
  - **4 を省略しないこと。** スモークのアサーションは「応答が返る（ステータスは問わない）」「起動が例外を投げない」という**意図的に緩い形**なので（steps.md ステップ24）、注入試験を通していないと「常に緑を返すだけのテスト」と区別がつかない
  - `rm -rf apps/web/dist` から始めるのは、**クリーンな clone からブートストラップできること**の確認を兼ねているため（ローカル `wrangler.toml` の `main` が成果物を指しているとここで落ちる）

### 9. `pnpm start` / `pnpm preview` の起動可否を確定させる（#40 の解消確認）

- **対応する受け入れ基準:** AC-28（`CLAUDE.md` の記述が新構成と一致していること）
- **目的:** #40 の原因（`eventRelayWorker.ts` の module-scope `crypto.randomUUID()`）が #37 で消えるため、**現在起動できない2コマンドが起動できるようになった可能性がある。** steps.md ステップ29 は `CLAUDE.md` / `README.md` の「起動不能」の記述を削除すると決めているので、**削除してよいかを実際に確かめる**
- **手順:**
  1. `pnpm build:cf` 済みの状態で `pnpm start`（= `wrangler dev`）を実行する
  2. 起動ログを確認し、`Disallowed operation called within global scope` が出ないことを確認する
  3. 起動したら表示された URL（既定は `http://localhost:8787`）を開き、ログイン画面が出ることを確認する
  4. 別ターミナルで `pnpm dev:state` を併走させないと DO バインディングが解決できないかどうかを確認する（確認項目1 と同じ論点）
  5. `pnpm preview`（= `vite preview --config vite.config.cloudflare.ts`）についても 1〜3 を行う
- **期待結果（断定しない）:** **少なくとも `Disallowed operation called within global scope` は出ない**（原因モジュールが消えているため）。そこから先が通るかは実装後に確定する
- **確認ポイント:**
  - **結果は3通りありうる。どれだったかを PR 本文に必ず記録する** — (a) 両方起動する → `CLAUDE.md` / `README.md` の但し書きを削除してよい（steps.md ステップ29）、(b) global scope とは**別の理由**で起動しない（DO バインディングの解決、`ASSETS` の不在など）→ 但し書きを**新しい原因に書き換える**か #40 とは別の Issue を立てる、(c) まだ global scope 違反が出る → **プロダクションコードに別の module-scope 乱数が残っている**（steps.md ステップ32 項目10 の grep で所在を特定する）
  - **(b) の場合に但し書きをそのまま消してはならない。** AC-28 が求めるのは「記述が新構成と一致していること」であって削除そのものではない

### 10. 全ゲートが通る

- **対応する受け入れ基準:** AC-29
- **目的:** 受け入れ条件11 が列挙する7コマンドが実際に緑になることを確認する
- **手順:** 次を順に実行する。

  ```bash
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm lint && pnpm format:check
  pnpm test:unit
  pnpm test:integration
  rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke
  ```

- **期待結果:** すべて exit 0
- **確認ポイント:**
  - **`pnpm test:integration:cf` はもう存在しない**（steps.md ステップ26 が `test:integration` 1本へ統合する）。叩くと `Command "test:integration:cf" not found` になるのが正しい
  - `ERR_PNPM_OUTDATED_LOCKFILE` が出たら lockfile の再生成漏れ（steps.md ステップ19 / 24 の両方で `pnpm install` が要る）
  - **テストファイル数・ケース数の増減を実測して PR 本文に残す**（削除 / 追加 / 移植の内訳。steps.md ステップ32 項目12）

---

## エッジケース・異常系

### 1. 登録済みメールで再度サインアップするとフォーム内にエラーが出る

- **目的:** Identity Directory DO の一意制約違反が**アダプターで** `ConflictError("EMAIL_ALREADY_REGISTERED")` へ翻訳され（usecase の `catch` は削除されている。steps.md ステップ15 / 18）、値エンベロープで request Worker まで戻り、UI に届く経路が生きていることを確認する
- **手順:**
  1. `/signup` で確認項目3 と同じ `do-check@example.com` を再度送信する
- **期待結果:** 画面遷移せずフォーム内にエラーメッセージが表示される。500 画面やスタックトレースは出ない
- **確認ポイント:** **英語の生の例外文言や `SQLITE_CONSTRAINT_UNIQUE` が出たら、翻訳がアダプターに戻っていない。** 同期 commit では UNIQUE 違反が `insert` のその場で上がるので、deferred-batch 前提の `catch` は機能しない（plan.md リスク欄）

### 2. 誤ったパスワードでログインするとフォーム内にエラーが出る

- **目的:** アプリケーション層のエラーがサーバー関数境界で直列化され UI まで届くこと、および**未登録メールと誤パスワードで応答が区別できない**ことを確認する
- **手順:**
  1. `/login` で `do-check@example.com` + 誤ったパスワードを送信する
  2. 次に**未登録の** `no-such-user@example.com` + 任意のパスワードを送信する
  3. 2つのレスポンス（DevTools Network）とエラー表示を見比べる
- **期待結果:** どちらも画面遷移せずフォーム内に**同じ**エラーメッセージが出る。レスポンスの中身も区別がつかない
- **確認ポイント:** **応答が違うとメール登録の有無が漏れる**（`lookupCredential` の均一化。steps.md ステップ16）。所要時間も極端に違わないこと（ダミー材料での計算量均一化）

### 3. state Worker を止めた状態でログインすると 5xx になり内部詳細が漏れない

- **目的:** DO へ到達できないときに `platform/stubErrors.ts` が `SystemError` へ翻訳し、**生のプラットフォームエラーが画面へ出ない**ことを確認する（`CLAUDE.md`「platform failures raised by the stub call itself … never enter the envelope」）
- **手順:**
  1. `pnpm dev:state` のターミナルを Ctrl-C で止める（確認項目1 で単独起動が成立した場合は、この項目は skip してよい旨を記録する）
  2. ブラウザで `/login` からログインを試みる
  3. 表示とレスポンスを確認する
  4. `pnpm dev:state` を再起動し、ログインできることを確認する
- **期待結果:** エラー画面またはフォーム内エラーが出る。**`Durable Object` / `overloaded` / `ctx.abort` といった内部文言がユーザーに見える形で出ない**
- **確認ポイント:** ここでアプリが**ハングする**（タイムアウトしない）なら、stub 呼び出しの失敗を握っていない

### 4. 未認証で保護画面を直接開くと `?redirect=` 付きでログインに飛び、ログイン後に戻る

- **目的:** リダイレクト往復が DO 移行の巻き添えを受けていないことを確認する
- **手順:**
  1. シークレットウィンドウで `http://localhost:3000/settings` を直接開く
  2. 遷移先 URL を確認する
  3. 確認項目3 の資格情報でログインする
- **期待結果:** `/login?redirect=%2Fsettings` に飛び、ログイン成功後は `/` ではなく `/settings` に戻る

### 5. セッション cookie を改ざんしても他人のデータに到達できない

- **目的:** **認可の権威が DO 側の epoch ガードへ移った**（`requireUserId()` は「トークン真正性の前段チェック」に降格。steps.md ステップ19）ことを、実際に壊しにいって確認する
- **手順:**
  1. ログイン済みの状態で DevTools からセッション cookie の値を1文字書き換える
  2. `/settings` をリロードする
  3. cookie を消して `/settings` をリロードする
  4. **別のアカウント**（`do-check2@example.com`）を作り、そちらの cookie を1 の状態へ貼り替えて `/settings` を開く
- **期待結果:** 2 / 3 はログイン画面へ飛ぶ。4 は**貼り替えた側のアカウントの情報しか見えない**（署名が壊れていれば拒否、正しい署名なら本人のデータ）
- **確認ポイント:** **`userId` 以外の入力から DO を選べない**のが AC-4 の主張である。cookie の中身を書き換えて他人の `userId` を詰めても、署名検証で落ちるのが正しい

### 6. `SESSION_SECRET` / `DIRECTORY_ROUTING_SECRET` が未設定・不正だとリクエストが失敗する

- **目的:** 秘密の検査が**起動時ではなくリクエスト時**に効くこと（Cloudflare では boot フェーズに `env` が無いので必然）と、keyring の構築時検査（`active` ちょうど1件など）が実際に効くことを確認する
- **手順:**
  1. `apps/web/.dev.vars` の `SESSION_SECRET` を一時的に空にして dev を再起動し、`/login` を開く
  2. 値を戻す
  3. `DIRECTORY_ROUTING_SECRET` の keyring から `bucketCount` を消す（または `active` を2件にする）
  4. `/login` からログインを試みる
  5. 値を戻して正常に戻ることを確認する
- **期待結果:** 1 と 4 のどちらもリクエストがエラーになる。**起動そのものは成功する**（起動時に落ちるのは Cloudflare では正しくない）
- **確認ポイント:** 4 でエラーにならず**そのまま動いてしまう**なら、keyring の検査（steps.md ステップ17 の (i)〜(iv)）が実装されていない。**検査を通した値しか型を得られない形**になっているか確認する

### 7. 存在しないパスで 404 画面が出る

- **目的:** ルーターの not-found 経路が無傷であることを確認する
- **手順:** `http://localhost:3000/no-such-page` を開く
- **期待結果:** 「ページが見つかりません」の画面が表示され、「タイムラインへ」のリンクから `/` に戻れる

---

## 既存機能への影響確認

- **グローバルナビの5画面** — ログイン済みで 1280px（サイドバー）と 390px（ヘッダー + ナビシート）の両方から、「タイムライン」→「トピック」→「検索」→「ゴミ箱」→「設定」を順に開き、**各画面でリロード（SSR 経路）も通す。** `/` は「まだメモがありません」、`/topics` `/search` `/trash` は「準備中です」、`/settings` はアカウント情報。ヘッダーとブラウザタブのタイトルが各画面のラベルに追随すること。**#37 は CSS に一切触らないので、見た目が変わっていたら別の原因。**

- **`/password-reset` 画面** — 「この機能は準備中です」のままであることを確認する。**#37 は `requestPasswordReset` の usecase と `send-mail` ジョブを実装するが、それを起動する UI は作らない**（完了フローは #12）。ここに新しいフォームが生えていたらスコープ逸脱である。

- **フォームの3層構造** — サインアップ / ログインの送信中に pending 表示になること、ログアウトボタンが「ログアウト中…」で disabled になること（`useActionState` / `useTransition`）。#37 は presentation の構造を保つと決めている（steps.md「UI / プレゼンテーション」）ので、**ここが退行していたら server function の配線を変えすぎている。**

- **`readAuthStateFn` が DO を叩かないこと** — `/settings` へのクライアント遷移で、`/_serverFn/...` の呼び出しが**認証状態の確認**と**保護データの取得**で分かれていること（DevTools Network）。`readAuthStateFn` は DO を叩かないまま残す設計で、**保護データを返す実行点だけが DO を経由する**（steps.md「UI / プレゼンテーション」2）。

- **CI の3ジョブ** — PR 上で `lint-typecheck-unit` / `integration` / `build` が緑になること。**`integration` ジョブのコマンドが `pnpm test:integration` へ、`build` ジョブに `pnpm test:smoke` が足されている**こと（steps.md ステップ28）。`test:integration:cf` を叩いたままなら CI が確実に落ちる。

- **`README.md` / `CLAUDE.md` / `docs/test.md` の案内が実行可能であること** — 書かれているコマンドを1つずつ実際に叩く。とくに **`db:*` への言及が残っていたら、そのコマンドはもう存在しない**（AC-18 / steps.md ステップ26 / 29）。`docs/backend_implementation_example.md` は冒頭に「#38 で書き換える」警告ブロックがあることだけ確認する（中身は古いままが正）。

- **機械的な残骸チェック（ブラウザでは見えない分）** — steps.md ステップ32 の項目9〜11 を実行する。とくに **項目10 の module スコープ grep**（`randomUUID` / `getRandomValues` / `Date.now` / `setTimeout` / `setInterval` / `fetch(`）は、ヒット行がすべて関数本体の中にあることを**件数ではなく所在で**1件ずつ確認する — 確認項目8 のスモークは**時刻取得（`Date.now()`）を検知しない**（workerd が禁じていないため）ので、ここだけは目視が唯一の担保である。
