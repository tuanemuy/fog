# レビュー 001 — Infrastructure / Adapters

**対象:** PR #17（`issue/1/skeleton-auth`）
**観点:** アダプター層（スキーマ / マイグレーション / リポジトリ / 暗号アダプター / DI 配線 / アダプター統合テスト）
**参照:** `.issue/1/plan.md`（AC-5 / AC-6 / AC-7・「設計 > アダプター / 永続化 / 外部連携」）、`.issue/1/adr.md`（ADR-001 / 003 / 008 / 010 / 014 / 015）、`spec/database/index.md#users`、`spec/domains/identity.md`、`spec/inventory/adapter.md`

## 検証の方法

指摘の根拠にした実測を先に置く（読み合わせだけの推測と区別するため）。

| 実測 | コマンド | 結果 |
|---|---|---|
| d1 / libsql マイグレーション SQL の一致 | `diff .../d1/migrations/0000_initial.sql .../libsql/migrations/0000_initial.sql` | **バイト一致** |
| journal / snapshot の差分 | `diff meta/_journal.json` / `diff meta/0000_snapshot.json` | `when`（生成時刻）と `id`（UUID）のみ。エントリ・スキーマ定義は同一 |
| スキーマ ↔ スナップショットのドリフト | `apps/web` で `drizzle-kit generate --config=./drizzle.config.ts` / `--config=./drizzle.libsql.config.ts` | **両方 "No schema changes, nothing to migrate"**（再生成漏れなし） |
| `meta/` 追加後の D1 プール起動 | `vitest run --config vitest.config.integration.ts .../d1/__tests__/userRepository.integration.test.ts` | **9/9 pass**（`readD1Migrations` のトップレベル await は `meta/` に影響されない。ADR-001 の S-004 解消を追認） |
| libsql 統合テスト | `vitest run --config vitest.config.integration.node.ts .../libsql/__tests__/userRepository.integration.test.ts` | **9/9 pass**（journal 走査への書き換えが機能している） |
| 暗号アダプター単体 | `vitest run --config vitest.config.ts packages/core/src/adapters/webcrypto` | **24/24 pass** |
| base64url 実装の往復 | 0〜69 バイトの全長で `fromBase64Url(toBase64Url(b))` を照合 | **全長で一致**（パディング計算に誤りなし） |
| `todo` 残滓 | `grep -rli todo packages/core/src apps/web/app apps/web/scripts infra` | **0 件** |

## 受け入れ基準の判定

| AC | 判定 | 根拠 |
|---|---|---|
| **AC-5**（`users` の名前付き制約6本 + インデックス2本、共通基盤3テーブル） | **満たす（テストによる担保は無し → W-005）** | `d1/schema.ts:39-64` に `users_auth_method_sum` / `users_auth_method_valid` / `users_sso_provider_valid` / `users_sso_subject_nonempty` / `users_trash_retention_positive` の5 CHECK と `users_email_uq` / 部分一意 `users_sso_identity_uq`。生成 SQL・snapshot の双方に反映済み。`outbox_events` / `processed_events` / `_occ_guard` と `idx_outbox_pending` の部分インデックスも保存されている |
| **AC-6**（d1 / libsql 両実装、OCC 0行更新 → `OPTIMISTIC_LOCK_FAILURE`、不整合行 → `SystemError(DataIntegrityError)`、`EMAIL_ALREADY_REGISTERED` はユースケース境界） | **満たす** | 両リポジトリの `toUser` / `toVersioned` / `addOcc` が対称。`registerWithPassword.ts:61-79` の catch が `UNIQUE_VIOLATION` を読み替え、前提条件（`users` insert 1件 + outbox・`PasswordUser` なので部分索引は不発・UUIDv7 PK）を JSDoc に列挙済み |
| **AC-7**（タイミングセーフ照合、不一致は `false`） | **満たす** | `pbkdf2PasswordHasher.ts:136-140` は `timingSafeEqual`（`encoding.ts:32-37`、短絡なし）で比較し `boolean` を返す。throw するのは計算失敗（`CryptoError`）と保存値の形式不正（`DataIntegrityError`）のみ。`hmacSessionCodec` は `crypto.subtle.verify` に任せている |

`spec/database/index.md#users` との照合も1行ずつ確認した。列名・型・NOT NULL・nullable・直和 CHECK の論理式（spec の SQL とリテラル一致）・`length(sso_provider_subject) > 0`・`trash_retention_days >= 1`・`version`・`created_at` / `updated_at` の `integer(timestamp_ms)`・**SQL DEFAULT を1つも置いていないこと**、すべて仕様どおり。`SsoProvider` VO の値域（`"google" | "apple"`）と `users_sso_provider_valid` の CHECK も一致している。

---

### Infrastructure / Adapters

#### Blockers

なし。

スキーマ・マイグレーション・リポジトリ・暗号アダプターのいずれにも、設計と食い違う実装や誤りは見つからなかった。以下はすべて「動くが、運用・回帰耐性・不変条件の担保が薄い」種類の指摘である。

#### Warnings

- **[W-001]** マイグレーションのタグ `0000_initial` を内容を差し替えたまま再利用しており、既に適用済みの環境が壊れる（しかも d1 は**黙って**壊れる）
  - 場所: `packages/core/src/adapters/d1/migrations/0000_initial.sql`、`packages/core/src/adapters/libsql/migrations/meta/_journal.json:8`
  - 理由: ADR-001 の「未デプロイなのでリセットする」判断自体は妥当だが、**ファイル名を据え置いたことで既存台帳との相互作用が2通りに分かれる**。
    - **libSQL**: journal の `when` が `1778679250584` → `1784941160500` に進んだので、`drizzle-orm/libsql/migrator` は「未適用の新しいマイグレーション」と判断して**再実行**する。既存の `apps/web/data/app.db` では `CREATE TABLE _occ_guard` が `table already exists` で落ち、`pnpm db:migrate` が失敗する。PR 説明には `rm -f apps/web/data/app.db` があるが、**リポジトリ内のドキュメント（`docs/runtime_node.md`）には何も書かれていない**
    - **ローカル D1**: `wrangler d1 migrations apply` の台帳 `d1_migrations` は**ファイル名**で適用済みを判定する。ファイル名が `0000_initial.sql` のままなので、既に適用済みの `.wrangler/state` では**スキップされ、`users` が永久に作られない**。エラーも出ないため、`pnpm dev:cf` が「なぜか `no such table: users`」で失敗する形になる。この経路は PR 説明にも記載がない
  - 提案: どちらかを採る。(a) 生成名を `0000_fog_initial` 等に変えて台帳と衝突させない（リセットの意図が名前に残る利点もある）。(b) 名前を維持するなら、`docs/runtime_node.md` と `docs/runtime_cloudflare.md` に「このリリースはマイグレーションをリセットしているので、既存のローカル DB（`apps/web/data/app.db*` / `apps/web/.wrangler/state/v3/d1`）を削除してから `pnpm db:migrate` / `pnpm db:migrate:cf` を実行する」旨を明記する。少なくとも **D1 側の silent skip は必ず文書化する**（失敗が無症状なので、知らない人は原因に到達できない）

- **[W-002]** `SESSION_SECRET` のランタイム別ドキュメントが GCP だけ更新され、Node / Cloudflare / AWS が置き去りになっている
  - 場所: `docs/runtime_node.md:49` 付近（環境変数表）、`docs/runtime_cloudflare.md:30`、`docs/runtime_aws.md:109` / `:176`（変更なし）。更新されたのは `docs/runtime_gcp.md:45` のみ
  - 理由: `.env.example` / `.dev.vars.example` / `.env.aws.example` / `.env.gcp.example` の4つには追記されているのに、運用手順の正であるランタイムドキュメントには反映されていない。特に AWS は影響が大きい: `infra/aws/bin/app.ts:19,25` が `SESSION_SECRET_ARN_<STAGE>` を**必須化**し、未設定のステージは既存の `continue` で**黙って synth から消える**。`docs/runtime_aws.md:109` は今も `TURSO_URL_STAGING` / `TURSO_AUTH_TOKEN_SECRET_ARN_STAGING` / `APP_URL_STAGING` の3つしか列挙していないので、手順どおりに `cdk deploy` した人はスタックが生成されない理由に辿り着けない。Cloudflare も `wrangler secret put SESSION_SECRET` の言及がなく、`.dev.vars` だけ見てローカルは動くのにデプロイ後の全リクエストが 500 になる
  - 提案: 3ファイルに追記する。`runtime_node.md` の環境変数表に `SESSION_SECRET`（required: yes / リクエストパスのみ）、`runtime_cloudflare.md` のデプロイ手順に `wrangler secret put SESSION_SECRET`、`runtime_aws.md:109` の stage-keyed 変数リストと `:114` の例、`:176` の env 表に `SESSION_SECRET_ARN`。ADR-015 で決めた「4ワーカーには配らない」も1行添えると意図が残る

- **[W-003]** `createHmacSessionCodec` の鍵インポートのメモ化が、リクエスト毎のコンテナ生成で無効化されている。JSDoc の主張と実態が食い違う
  - 場所: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:50-62`
  - 理由: コメントは「Imported once and shared: `importKey` is async, and re-running it per request would add a needless await to every authenticated hit.」と書くが、`keyPromise` はファクトリのクロージャ変数であり、そのファクトリは `createNodeRequestContainer` / `createRequestContainer` / `createAwsRequestContainer` / `createGcpRequestContainer` の中で呼ばれる。そしてこれらは**リクエスト毎**に呼ばれる（`apps/web/app/server.node.ts:102` の `fetch` 内、`apps/web/app/server.cloudflare.ts:43` の `fetch` 内）。つまり `importKey` は実際には毎リクエスト走っており、メモ化が効くのは同一リクエスト内で `issue` と `verify` を両方叩いた場合だけ。実害は小さい（HMAC の raw importKey は安価）が、**コメントが読者に事実と異なる保証を与えている**のが問題で、「ここは最適化済み」と信じた次の実装者がプロファイルを誤読する
  - 提案: どちらかに揃える。(a) コメントを実態に合わせて「同一リクエスト内の複数呼び出しをまとめるためのメモ化」と書き直す。(b) 本当に1度だけにしたいなら、codec のインスタンスをモジュールスコープの `Map<secret, SessionCodec>` でキャッシュするか、DI 側で `createXxxRequestContainer` の外（boot 時 / モジュールスコープ）に codec を1つ作って注入する。同じ話は `createPbkdf2PasswordHasher()` にも当てはまる（こちらは状態を持たないので実害ゼロ）

- **[W-004]** 暗号アダプターのファクトリが自分の引数を検証していない。不変条件が DI 層の `requireSessionSecret` 1箇所にしか存在しない
  - 場所: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:44-47`、`packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:122-125`
  - 理由: `createHmacSessionCodec({ secret: "x" })` は通る。32文字以上という要件は `packages/core/src/application/di/secrets.ts:31-38` にしかなく、**アダプターを直接構築する経路（テストヘルパー2本、将来の新エントリポイント、MCP / CLI アプリ）はこのガードを通らない**。同様に `createPbkdf2PasswordHasher({ iterations: 1 })` も通る。ADR-003 は「呼び出し側が誤って低い値を渡す余地が生まれる」ことを Consequences で認識しつつ、「本番の配線は既定値を使う運用にする」という**運用上の約束**でしか塞いでいない。CLAUDE.md の「Make illegal states unrepresentable at the type level before falling back to runtime checks」「Validate at the boundaries（value-object construction）」からすると、ファクトリはまさに construction boundary であり、ここに置かない理由が弱い
  - 提案: ファクトリ内で最低限の表明を行う。`createHmacSessionCodec` は `secret.length < 32` で throw（`MIN_SESSION_SECRET_LENGTH` を `secrets.ts` から共有するか、逆にアダプター側を正にして DI が参照する）。`createPbkdf2PasswordHasher` は `iterations` に下限（例: 1,000 未満は throw）を置く。DI 側の `requireSessionSecret` は「env の欠落を人間に読めるメッセージで伝える」役割として残してよい（二重化は害にならない）

- **[W-005]** `users` に追加した名前付き制約6本と部分一意インデックスに、挙動を確かめるテストが1件も無い
  - 場所: `packages/core/src/adapters/{d1,libsql}/__tests__/userRepository.integration.test.ts`（該当なし）。制約名の文字列は `schema.ts` と migrations、および `registerWithPassword.ts:71` のコメントにしか現れない
  - 理由: AC-5 は「名前付き制約6本 + インデックス2本を持つ」を受け入れ条件にしているのに、証拠が**生成された SQL テキストだけ**になっている。特に問題なのは、**ADR-008 の安全性論拠が `users_sso_identity_uq` の部分性に依存している**点である（`registerWithPassword.ts:70-72`「The inserted user is a `PasswordUser`, so both SSO columns are NULL and the partial index `users_sso_identity_uq` cannot match」）。この前提が実行によって一度も確認されていないため、将来 `where(...)` が落ちたり列順が変わったりしても、`UNIQUE_VIOLATION` → `EMAIL_ALREADY_REGISTERED` の一括読み替えが誤って発火する経路に気づけない。同じことが直和 CHECK にも言える — `mapDbError` は `SQLITE_CONSTRAINT_CHECK` を `ConflictError("CONSTRAINT_VIOLATION")` に落とすので、CHECK が消えても消えなくてもユースケースの見え方が変わらず、退行が無症状になる
  - 提案: `userRepository.integration.test.ts`（または新規の `schema.integration.test.ts`）に、生 SQL で行を差し込む数件を足す。最低限この3つ:
    1. `PasswordUser` を2件 insert して**衝突しない**こと（部分一意インデックスが password 行を巻き込んでいない）
    2. 同一 `(sso_provider, sso_provider_subject)` の SSO 行2件が**衝突する**こと
    3. `auth_method = 'password'` かつ `sso_provider` 非 NULL の行、`trash_retention_days = 0` の行が**拒否される**こと（`users_auth_method_sum` / `users_trash_retention_positive`）

    既に `rawRow(...)` ヘルパーがあるので、追加コストは小さい。d1 / libsql 両方に置けば ADR-004 の「二重化の維持」も同時に守れる

- **[W-006]** `parse()` が保存ハッシュの反復回数に上限を課していない
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:74-80`
  - 理由: 下限（`Number.isInteger && >= 1`）はあるが上限が無い。`users.password_hash` に `pbkdf2-sha256$100000000000$…` が入ると、そのアカウントへの1回のログインが CPU バウンドで事実上ハングする（Workers なら CPU 制限で落ち、Node なら1リクエストがイベントループのワーカースレッドを占有し続ける）。ADR-014 が「保存値が読めない = マイグレーション / データ移行の破綻」を `DataIntegrityError` として区別する設計を採っている以上、「読めるが桁が異常」も同じ扱いにするのが自然。到達には DB 書き込み権限が要るので深刻度は高くないが、**修正は既に検証が並んでいる関数への1行追加**であり、コスト比で見合う
  - 提案: `MAX_PBKDF2_ITERATIONS`（例: 10,000,000）を置き、超過を `DataIntegrityError` にする。ついでに `Number(iterationsRaw)` が `" 12 "` のような空白入りを受理する点も、`/^\d+$/` の事前検査で塞げる

- **[W-007]** `SESSION_SECRET` の必須性検査がリクエスト毎に走り、生の `Error` が redaction 境界の外に出る。起動時には検出されない
  - 場所: `packages/core/src/application/di/secrets.ts:31-38` を呼ぶ `serverNode.ts:139` / `serverCloudflare.ts:152` / `serverAws.ts:160` / `serverGcp.ts` の各 `createXxxRequestContainer`
  - 理由: ADR-004 の「env スキーマは optional、必須性は消費地点で」という判断は妥当（ワーカーが起動できなくなる問題を正しく回避している）。ただし結果として、**Node では `apps/web/app/server.node.ts:102` の `fetch` の中**で毎回検査され、`storage.run(...)` の**前**に throw するため `errorResponseMiddleware` を通らない。設定ミスは「起動は成功、全リクエストが素の 500」という形で現れる。PR 説明の「`SESSION_SECRET` 不正時の**起動時**エラー」という記述とも食い違っている。さらに毎リクエスト同じ検査を繰り返すのは、`requireSessionSecret` の JSDoc が言う「the one place that consumes it」の意図（1箇所で1回）とも噛み合っていない
  - 提案: 少なくとも Node については、`readNodeRequestServerConfig`（`server.node.ts:90` で **boot 時に1回だけ**呼ばれる）で `requireSessionSecret` を通し、`secrets.sessionSecret` に検証済みの値を入れる。ワーカー側は `readNodeServerEnv` しか通らないので、ADR-004 の懸念は再発しない。CF / Lambda は per-request 構築が構造上避けられないので現状維持でよいが、PR 説明と `.issue/1/testing.md` の「起動時エラー」の記述はランタイム別に書き分けるべき

- **[W-008]** `encoding.ts` の base64 系エクスポートに JSDoc もテストも無く、非正規入力を受理する挙動が未文書化
  - 場所: `packages/core/src/adapters/webcrypto/encoding.ts:1-24`（`timingSafeEqual` だけ JSDoc あり）
  - 理由: このモジュールは `pbkdf2PasswordHasher` と `hmacSessionCodec` の**両方**が依存する共有面であり、実質的にセッショントークンとパスワードハッシュのワイヤ形式を決めている。にもかかわらず `packages/core/src/adapters/webcrypto/__tests__/` に `encoding.test.ts` が無く、往復の正しさは上位2モジュールのテストからの間接的な担保しかない。実測では0〜69バイトの全長で往復が正しいことを確認できたが、`fromBase64Url` は**標準 base64 の `+` / `/` も、埋め込まれた空白も受理する**（`atob` の forgiving 動作）。セキュリティ上の問題ではない（署名バイト列が一致しなければ検証は落ちる）が、「トークン文字列が一意に正規化されない」という性質は明示されていないと、将来トークン文字列そのものを比較・索引するコードが書かれたときに事故になる。CLAUDE.md の「Library-level JSDoc on exported APIs is welcome」に照らしても薄い
  - 提案: `encoding.test.ts` を1本足して往復（0バイト・1〜2バイトのパディング境界・33バイト）とエラー入力を固定する。あわせて `fromBase64Url` に「forgiving-base64 なので `+` / `/` / 空白も受理する。トークン文字列の一意性を前提にしないこと」と1行 JSDoc を置く。4関数を外部公開する必要が無いなら（実際 `webcrypto/` の外からは使われていない）、`toBase64` / `fromBase64` は非公開にして面を減らす手もある

#### Notes

- **[N-001]** **スキーマは spec と1行ずつ一致している。** 直和 CHECK は `spec/database/index.md#users` の SQL とリテラル一致、`users_sso_subject_nonempty` / `users_sso_provider_valid` / `users_auth_method_valid` / `users_trash_retention_positive` を独立させて「どの不変条件が破れたか制約名で判別できる」ようにした plan.md の意図もそのまま実装されている。タイムスタンプは `integer(timestamp_ms)`、SQL DEFAULT はゼロ、`trash_retention_days` の既定30も application 側（`TrashRetentionDays.default()`）に閉じている。`d1/schema.ts:11-16` のコメントがこの「DEFAULT を置かない」理由（`Clock` 由来でテストが時間を凍結できる）を明示しているのが良い

- **[N-002]** **マイグレーション2セットにドリフトが無い。** `0000_initial.sql` はバイト一致、snapshot は UUID だけの差、journal は生成時刻だけの差。さらに `drizzle-kit generate` を両 config で回して**どちらも no-op** だったので、「スキーマを直したのにマイグレーション再生成を忘れた」というクラスの事故（ADR-004 が「型検査で検出できない」と警告していたもの）は現時点で発生していない。共通基盤3テーブルと `idx_outbox_pending` の部分インデックス（`WHERE processed_at IS NULL AND failed_at IS NULL`）も失われていない

- **[N-003]** **d1 / libsql のリポジトリ実装差が `PendingBatch` の API 差だけに収まっている。** `insert` の `this.db.insert(...)` vs `(tx) => tx.insert(...)`、`addOcc` の第1引数の形。それ以外（`toUser` / `toVersioned` / `authColumns` / `toInsertValues` / `toUpdateValues` / `findByEmail` の等値比較）は完全に同型で、テストも意図的にミラー構成（libsql 側に「Mirrors `d1/__tests__/userRepository.integration.test.ts`」の注記あり）。`SsoProvider` を `google` / `apple` で振り分けているのも、両側が同じ CHECK を通ることの確認になっていて良い

- **[N-004]** **`ExpectedVersion` の生成キャストが `toVersioned` 1箇所に閉じている。** `expectedVersion as number`（`userRepository.ts:120`）はブランド型を素の `number` へ広げる向きのキャストで、テンプレートの `todoRepository` と同じ書き方。トークンの偽造経路を増やしていない。`domain/common/transactionalRepository.ts` の JSDoc も `Memo` / `User` を例に更新されており、todo 由来の記述が残っていない

- **[N-005]** **ADR-008 の読み替えの前提が、コードと同じ場所に列挙されている。** `registerWithPassword.ts:62-74` のコメントが「この UoW が書くのは users insert 1件 + outbox 行だけ」「対象は `PasswordUser` なので部分索引は不発」「PK は UUIDv7」「別の一意制約を持つ書き込みを足したらこの翻訳は外す」まで書いており、リポジトリ側（`userRepository.ts:29-32`）と `ports/userRepository.ts:31-35` の3箇所から同じ ADR に紐づいている。読み替えという例外的な設計が「なぜ許されるか」と「いつ壊れるか」の両方を残せている点は、後続スライスの手本になる

- **[N-006]** **テストヘルパーに軽い重複がある。** `TEST_SESSION_SECRET` と `TestContainerOverrides` が `packages/core/src/application/__tests__/helpers.ts:34-38` と `packages/core/src/adapters/d1/__tests__/helpers.ts:25-29` に同一定義で2本ある。片方から re-export すれば済む。あわせて後者だけ `import { createHmacSessionCodec } from "../../webcrypto/hmacSessionCodec"` と**相対パス**で、他は全て `@repo/core/adapters/...` エイリアス。アダプターグループを跨ぐ import はエイリアスに揃えたほうが grep しやすい

- **[N-007]** **`FakePasswordHasher` は平文を `password_hash` 列に書く**（`fake$${plain}`）。テスト専用なので実害は無いが、ADR-011 が「永続化への漏出は `users` テーブルに平文列が存在しないことで構造的に閉じている」と論じている以上、統合テストの DB には実際に平文が入っているという事実は認識しておいたほうがよい。将来「永続化に平文が現れないこと」を表明するテストを書くなら、そこだけ実ハッシャー（低反復）を注入する必要がある

- **[N-008]** **`loginWithPassword` のタイミング差によるユーザー列挙**は `loginWithPassword.ts:29-31` に既知の限界として明記されており、隠蔽していない点は良い。塞ぐ場合はアダプター側に「固定ダミーハッシュに対する verify」を用意するのが素直（`PasswordHasher` ポートに手を入れず、ユースケースが `verify(plain, DUMMY_HASH)` を呼ぶだけでよい）。本スライスの範囲外なので指摘ではなく参考

- **[N-009]** **CHECK 違反が `ConflictError("CONSTRAINT_VIOLATION")`（HTTP 409）になる**点は、テンプレート由来の既存挙動（`repositories/helpers.ts` の `constraintViolationCode` が `SQLITE_CONSTRAINT_CHECK` を既定分岐に落とす）で本 PR の導入ではない。ただし本 PR で CHECK が5本増えたことで**初めて実際に到達しうる**ようになった。スキーマの不変条件違反は本来アプリケーションのバグ（= `SystemError`）であってユーザーに見せる競合ではないので、後続スライスで `SQLITE_CONSTRAINT_CHECK` を `SystemError(DataIntegrityError)` に分類し直すことを検討する価値がある。`_occ_guard` の CHECK は `isOccGuardViolation` が先に拾うので、この変更は OCC 経路に影響しない
