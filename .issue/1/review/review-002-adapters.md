# レビュー 002 — Infrastructure / Adapters

**対象:** PR #17（`issue/1/skeleton-auth`） / Issue #1
**観点:** アダプター層（スキーマ / マイグレーション / リポジトリ / 暗号アダプター / DI 配線 / インフラ / ランタイム docs）
**前提:** ラウンド2。`.issue/1/review/review-001-adapters.md` の W-001〜W-008 と `.issue/1/review/triage.md` の判定を踏まえ、解消確認 + ゼロベースの再レビュー。
**参照:** `.issue/1/plan.md`（AC-5 / AC-6 / AC-7）、`.issue/1/adr.md`（ADR-003 / 004 / 008 / 014 / 015）、`spec/database/index.md#users`、`spec/domains/identity.md`

## 検証の方法

読み合わせだけの推測と区別するため、指摘・判定の根拠にした実測を先に置く。

| 実測 | コマンド / 手順 | 結果 |
|---|---|---|
| d1 / libsql マイグレーション SQL の一致 | `diff .../d1/migrations/0000_initial.sql .../libsql/migrations/0000_initial.sql` | **バイト一致** |
| journal の差分 | `diff meta/_journal.json` | `when` のみ（`1784941159923` / `1784941160500`）。tag・entries は同一 |
| スキーマ ↔ マイグレーションのドリフト | `apps/web` で `drizzle-kit generate` を `drizzle.config.ts` / `drizzle.libsql.config.ts` の両方で実行 | **両方 "No schema changes, nothing to migrate"**（4 tables / users 10 columns 2 indexes） |
| d1 統合テスト | `vitest run --config vitest.config.integration.ts packages/core/src/adapters/d1` | **6 files / 43 tests pass** |
| libsql 統合テスト | `vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/libsql` | **5 files / 37 tests pass** |
| 暗号アダプター単体 | `vitest run packages/core/src/adapters/webcrypto` | **27 pass** |
| 全単体テスト / 型検査 | `vitest run` / `pnpm typecheck` | **288 pass** / 4 パッケージすべて Done |
| **W-001 docs 手順（Node）の再現** | `main` の旧 `0000_initial` を temp DB に適用 → 現行 `scripts/migrate.node.ts` を同じ DB に実行 | **`SqliteError: table _occ_guard already exists` で失敗**。docs/runtime_node.md の記述と実際の失敗メッセージが一致 |
| **W-001 docs 手順（Node・正常系）** | 空 DB に `migrate.node.ts` → 2回目も実行 | 1回目適用・2回目 no-op（冪等）。`rm -f` 後の手順は動く |
| **W-001 docs 手順（D1）の裏付け** | `wrangler d1 migrations apply ... --local` 実行後に `.wrangler/state/.../*.sqlite` を直読み | `d1_migrations` = `[{"id":1,"name":"0000_initial.sql",...}]`。**台帳キーがファイル名であることを実測で確認**（＝旧適用済み環境では silent skip する、という docs の説明は正しい）。`rm -rf apps/web/.wrangler/state/v3/d1` のパスも実在 |
| **W-002 AWS 部分設定検出** | `TURSO_URL_STAGING=libsql://x cdk synth` | **`Stage "staging" is partially configured: TURSO_AUTH_TOKEN_SECRET_ARN_STAGING, SESSION_SECRET_ARN_STAGING, APP_URL_STAGING unset.` で synth 失敗**（意図どおり） |
| **AWS 部分設定検出の抜け** | 4変数すべてを**空文字**で `cdk synth` | **`«Only» must use only one of secretCompleteArn or secretPartialArn` で失敗**（変数名を一切名指ししない）→ W-001 |
| **CloudFront 修正の synth 出力** | `cdk synth AppStack-staging` の `DistributionConfig` | `DefaultCacheBehavior.CachePolicyId = 4135ea2d-…`（Managed-CachingDisabled）/ `OriginRequestPolicyId = b689b0a8-…`（Managed-AllViewerExceptHostHeader）。`/assets/*` は `658327ea-…`（CachingOptimized）。**意図どおり** |
| **`fromBase64Url` の JSDoc の主張** | `atob` / `fromBase64Url` に空白入り・余剰パディングを与えて実測 | `"YWJj "` / `"YW Jj"` / `"YWJjZA==="` はいずれも **throw**。`+` `/` のみ受理 → W-002 |
| 全ランタイム docs の `SESSION_SECRET` | `git diff main..HEAD -- docs/` | node / cloudflare / aws / gcp の4本すべてに環境変数表 + ローテーション手順が追加済み |
| スクリプトの実在 | `package.json`（root / `@repo/web` / `@repo/infra-aws`） | docs が挙げる `pnpm db:migrate` / `db:migrate:cf` / `deploy:aws:synth` / `deploy:aws:diff` はすべて実在 |
| todo 残滓（コード） | `grep -rli todo packages/core/src apps/web/app infra` | **0 件**。ただし `docs/` に3件 → W-004 |

## ラウンド1指摘の解消状況

| ID | Key | 判定 | 根拠 |
|---|---|---|---|
| W-001 | `adapters/migrations/0000_initial の内容差し替え` | **解消** | `docs/runtime_node.md`「Replacing a migration in place」と `docs/runtime_cloudflare.md` 同節が追加。**D1 の silent skip が明示されている**（ラウンド1で最も重視した点）。両手順を実測で再現・確認済み |
| W-002 | `docs/SESSION_SECRET の記載漏れ` | **解消（残課題1件 → 新 W-001）** | 4ランタイム docs すべてに追記。AWS は `bin/app.ts` が部分設定を throw するようになり、synth で実際に検出されることを確認。ただし**空文字は「設定済み」と見なされる**見落としが残る |
| W-003 | `hmacSessionCodec/keyPromise メモ化` | **解消** | `hmacSessionCodec.ts:69-72` のコメントが「the calls of a single request: the DI factories build a container per request」と実態どおりに書き換えられた |
| W-004 | `webcrypto/ファクトリ引数の検証` | **解消（残課題2件 → 新 W-003 / W-005）** | `MIN_SESSION_SECRET_LENGTH`（`hmacSessionCodec.ts:16,60-64`）/ `MIN_PBKDF2_ITERATIONS`（`pbkdf2PasswordHasher.ts:22,154-158`）を追加、`@throws` も記載。テストが無く、定数が DI 側と二重化している |
| W-005 | `userRepository/制約の挙動テスト欠如` | **解消** | d1 / libsql 両方に `it.each` 6ケース（`users_auth_method_sum` ×2 / `_valid` / `_sso_provider_valid` / `_sso_subject_nonempty` / `_trash_retention_positive`）+ 部分索引の正例・負例2件。`causeChain` で制約名まで表明しており、`mapDbError` が CHECK を一律 `CONSTRAINT_VIOLATION` に潰す問題を回避できている。**ADR-008 の安全性論拠が実行で担保された** |
| W-006 | `pbkdf2/反復回数の上限検査` | **解消** | `MAX_PBKDF2_ITERATIONS = 10_000_000`（`pbkdf2PasswordHasher.ts:31,96-105`）。あわせて `/^\d+$/` の事前検査も入り `" 12 "` / `"1e5"` / `"0x10"` を弾く |
| W-007 | `di/secrets/生 Error の throw` | **解消** | Node は `server.node.ts:90` の boot 時 `readNodeRequestServerConfig` で検査。さらに `SessionSecret` ブランド型を新設し、「未検証の文字列を `RequestSecrets` に入れられない」を型で閉じた（当初提案より強い解決） |
| W-008 | `webcrypto/encoding/JSDoc とテスト欠如` | **部分解消 → 新 W-002 / W-003** | 4関数すべてに JSDoc が入ったが、`encoding.test.ts` は追加されず、かつ `fromBase64Url` の JSDoc が**実態より広い保証**を書いている |

## 受け入れ基準の判定

| AC | 判定 | 根拠 |
|---|---|---|
| **AC-5**（`users` の名前付き制約 + インデックス2本、共通基盤3テーブル） | **満たす** | `d1/schema.ts:39-64` の5 CHECK（`users_auth_method_sum` / `_auth_method_valid` / `_sso_provider_valid` / `_sso_subject_nonempty` / `_trash_retention_positive`）+ `users_email_uq` + 部分一意 `users_sso_identity_uq`。生成 SQL・snapshot に反映され、**ラウンド2で全件が挙動テストで担保された**。共通基盤は `outbox_events`（`idx_outbox_pending` 部分索引つき）/ `processed_events` / `_occ_guard`（`occ_guard_positive` CHECK）が生成 SQL に揃っている。`libsql/schema.ts` は `export * from "../d1/schema"` の再エクスポートで、単一出所も維持 |
| **AC-6**（d1 / libsql 両実装、OCC 0行 → `OPTIMISTIC_LOCK_FAILURE`、不整合行 → `SystemError(DataIntegrityError)`、`EMAIL_ALREADY_REGISTERED` はユースケース境界） | **満たす** | 両リポジトリの `toUser` / `toVersioned` / `authColumns` / `toInsertValues` / `toUpdateValues` は完全に同型で、差は `PendingBatch` の API 差（`this.db.insert(...)` vs `(tx) => tx.insert(...)`）のみ。OCC・不整合行・UNIQUE 違反の各テストが両側でミラーされ、d1 43件 / libsql 37件すべて green |
| **AC-7**（タイミングセーフ照合、不一致は `false`） | **満たす** | `pbkdf2PasswordHasher.ts:169-173` が `timingSafeEqual`（`encoding.ts:61-66`、短絡なし）で比較し `boolean` を返す。throw は計算失敗（`CryptoError`）と保存値の形式不正（`DataIntegrityError`）のみで、両方にテストがある |

`spec/database/index.md#users` との照合も再度1行ずつ行った。列名・型・NOT NULL / nullable・直和 CHECK の論理式（spec の SQL とリテラル一致）・`length(sso_provider_subject) > 0`・`trash_retention_days >= 1`・`integer(timestamp_ms)`・**SQL DEFAULT を1つも置いていないこと**、すべて仕様どおり。

---

### Infrastructure / Adapters

#### Blockers

なし。

スキーマ・マイグレーション・リポジトリ・暗号アダプター・CloudFront 配線のいずれにも、設計と食い違う実装や実行時に壊れる誤りは見つからなかった。CloudFront の修正（`originRequestPolicy`）は synth 出力で managed policy ID まで確認済みで、`CachingDisabled`（min/max/default TTL = 0）と組み合わせても認証済みレスポンスがエッジに載る経路は無い。

#### Warnings

- **[W-001]** AWS の部分設定検出が**空文字を「設定済み」と誤判定**する。CI で最も起こりやすい未設定の形が素通りする
  - 場所: `infra/aws/bin/app.ts:16-52`（`missing` の判定が `value === undefined` のみ）
  - 理由: 実測した。4つの stage-keyed 変数を**空文字**にして `cdk synth` すると、新設のガードは1つも発火せず `AppStack` の構築まで進み、`«Only» must use only one of secretCompleteArn or secretPartialArn`（`Secret.fromSecretCompleteArn`、`appStack.ts:74`）という**どの環境変数の話なのか一切名指ししないエラー**で落ちる。これは W-002 の修正が潰したかった失敗の形そのものである。しかも空文字は事故として現実的で、GitHub Actions の `SESSION_SECRET_ARN_STAGING: ${{ secrets.SESSION_SECRET_ARN_STAGING }}` はシークレット未登録時に**空文字**を渡すし、シェルでも `export FOO=` や未定義変数の `${FOO}` 展開で日常的に生じる。「未設定なら stage ごとスキップ」という逃げ道も空文字では効かない（4つとも空文字にしても `missing.length === 0` なので partial 判定にすら入らない）
  - 提案: 判定を `value === undefined || value === ""` に揃える。`const read = (key: string) => { const v = process.env[key]; return v === undefined || v === "" ? undefined : v; }` を1本置いて4箇所で使えば、`stageEnv` の組み立てと `missing` の算出が同じ規則になる。あわせて ARN 形式（`Secret.fromSecretCompleteArn` は6文字サフィックス付きの完全 ARN を要求する）も同じ地点で表明しておくと、部分 ARN を渡した場合も同じ「変数名を名指しするエラー」に収束する

- **[W-002]** `fromBase64Url` の新 JSDoc が**実態より広い保証**を書いている。W-003（「JSDoc の主張と実態が食い違う」）と同じクラスの問題が、その修正の隣で再発している
  - 場所: `packages/core/src/adapters/webcrypto/encoding.ts:38-49`
  - 理由: JSDoc は「standard-base64 `+` / `/`、**redundant padding** と **embedded whitespace** all decode rather than being rejected」と3つを並べているが、実測すると受理されるのは `+` / `/` だけである。

    | 入力 | 実測 |
    |---|---|
    | `"YW-_"` / `"YW+/"` | どちらも `97,111,191` に decode（主張どおり） |
    | `"YWJj "`（末尾空白） | **throws `InvalidCharacterError`** |
    | `"YW Jj"`（埋め込み空白） | **throws** |
    | `"YWJjZA==="`（余剰パディング） | **throws** |

    原因は実装側の `padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")` にある。`atob` 自体は空白を無視するが（`atob("YW Jj") === "abc"` を実測で確認）、この関数は**空白を含んだ長さでパディング量を計算する**ため、結果が 4 の倍数からずれて `atob` が拒否する。「forgiving」という性質を `fromBase64` から継承しているという説明が、`fromBase64Url` については成立していない。JSDoc の結論（「トークン文字列を canonical identity として扱うな」）自体は正しく、そこは残す価値があるが、**根拠として挙げた3例のうち2例が事実でない**のは、まさに W-003 で問題にした「読者に事実と異なる保証を与える」状態である
  - 提案: 実測に合わせて書き直す。「`+` / `_` の相互変換により標準 base64 も base64url も同じバイト列に decode する。一方、空白や余剰パディングはパディング計算がずれるため拒否される（`atob` 単体より狭い）」。そのうえで「複数の文字列が同一バイト列に写るので、トークン文字列を比較・索引・重複排除の鍵に使わないこと」を結論として残す。W-003 で `keyPromise` に対して行った「実態にコメントを合わせる」判断と同じ扱いにすればよい

- **[W-003]** ラウンド1で追加した**3つのガードすべてにテストが無い**。`encoding.test.ts` も結局追加されていない
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts`（`MIN_SESSION_SECRET_LENGTH` の表明なし）、`.../__tests__/pbkdf2PasswordHasher.test.ts:90-109`（`it.each` に上限ケース・下限ケースなし）、`packages/core/src/adapters/webcrypto/__tests__/encoding.test.ts`（不在）
  - 理由: W-004 / W-006 の修正は「不変条件を construction boundary に置く」ための追加なのに、その不変条件を確かめる実行が1件も無い。同じファイルの `it.each` はすでに `"zero iterations"`（`pbkdf2-sha256$0$…`）を持っており、**上限ケースは1行の追加で済む**。W-005 が「AC-5 の証拠が生成 SQL テキストだけ」を問題にして統合テストで解決された流れからすると、ここだけ「コードに書いたので終わり」で止まっているのは一貫していない。特に `MAX_PBKDF2_ITERATIONS` は `parse()` の分岐の中にあり、将来この条件式を触った人が上限を落としても誰も気づかない。また triage の Key は `adapters/webcrypto/encoding/JSDoc とテスト欠如` で判定 `fix` だが、テスト側は未着手のままである（W-002 の誤記も、往復テストがあれば書いた時点で気づけた）
  - 提案: 3点。(1) `pbkdf2PasswordHasher.test.ts` の `it.each` に `["iterations above the ceiling", "pbkdf2-sha256$10000001$c2FsdA==$aGFzaA=="]` と `["iterations with surrounding whitespace", "pbkdf2-sha256$ 1000 $c2FsdA==$aGFzaA=="]` を足す。(2) 両ファクトリの `@throws` を表明する2件（`createPbkdf2PasswordHasher({ iterations: 999 })` / `createHmacSessionCodec({ secret: "short" })`）を足す。(3) `encoding.test.ts` を1本作り、0バイト・1〜2バイトのパディング境界・33バイトの往復と、W-002 で確定させた受理/拒否の境界を固定する

- **[W-004]** 削除した todo 参照実装を、`CLAUDE.md` と `docs/` が今も「リファレンス」として指している
  - 場所: `CLAUDE.md:58`（`apps/web/app/components/todo/` is the reference for all of this）、`CLAUDE.md:60`（`apps/web/app/routes/todo/index.tsx` / `apps/web/app/components/todo/TodoListSkeleton`）、`docs/frontend_implementation_example.md:30,72,77,108,258,313,371,421,482,532,556,635`、`docs/test.md:21`、`docs/backend_implementation_example.md:242`
  - 理由: 本 PR は `apps/web/app/components/todo/` と `apps/web/app/routes/todo/` を全削除している（`git diff --stat`: 15 files / 688 deletions）。一方 `CLAUDE.md` は「Mutations は三層の関心事」「per-fragment streaming」の**唯一の参照実装**としてそれらのパスを名指ししたままで、`docs/frontend_implementation_example.md` は `TodoBoard` / `TodoItem` / `CreateTodoForm` / `loadTodos` を全編にわたって例示している。CLAUDE.md は次に入る実装者（人・エージェントを問わず）が最初に読む規約文書であり、そこから辿れる参照先が存在しないと、規約の意図が検証できない。**存在しないパスを指す docs は「実際に動く手順」ではない**。ラウンド1のレビューは `grep -rli todo` の対象を `packages/core/src apps/web/app apps/web/scripts infra` に絞っていたため、この範囲を見ていない
  - 提案: 参照先を本 PR で追加した実物に張り替える。三層ミューテーションと `useOptimistic` の owner 判断は `apps/web/app/components/auth/{LoginForm,SignupForm}` と `apps/web/app/components/settings/LogoutButton`、per-fragment streaming と skeleton は `apps/web/app/routes/_app/settings.tsx` + `apps/web/app/components/settings/SettingsSkeleton` が対応物になる。`docs/frontend_implementation_example.md` を全面書き換えるコストが本スライスに収まらないなら、最低限**冒頭に「例示中の `todo` はテンプレート由来のサンプルで、本リポジトリからは削除済み。パターンの説明として読むこと」の1行**を置き、`CLAUDE.md` のパス名指しだけは実在するものに直す

- **[W-005]** セッション鍵の最小長 32 が `secrets.ts` と `hmacSessionCodec.ts` に**二重定義**されており、同期を強制する仕組みが無い
  - 場所: `packages/core/src/application/di/secrets.ts:34`（`const MIN_SESSION_SECRET_LENGTH = 32`、非公開）、`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:16`（`export const MIN_SESSION_SECRET_LENGTH = 32`）
  - 理由: W-004 の提案は「`secrets.ts` から共有するか、逆にアダプター側を正にして DI が参照する」だったが、実装は両方に別々の定数を置いた。今は値が一致しているので害は出ないが、**ずれたときの壊れ方が悪い**。アダプター側だけ 64 に上げると、DI の `requireSessionSecret` は 32〜63 文字の秘密を通し、`SessionSecret` ブランドまで付けてしまい、その後 `createHmacSessionCodec` が**素の `Error`** を投げる。この throw 地点は Cloudflare では `createRequestContainer` の中、すなわち `errorResponseMiddleware` の外側なので、W-007 の修正で潰したはずの「起動は成功、全リクエストが素の 500」に戻る。同じリポジトリ内で `OCC_GUARD_CHECK_NAME` は**まさにこの理由で**アダプターから export して共有している（`d1/schema.ts:109-112` の「schema and detector must stay in lockstep」）のに、ここだけ手動同期になっているのは一貫していない
  - 提案: `secrets.ts` が `hmacSessionCodec.ts` の `MIN_SESSION_SECRET_LENGTH` を import する。DI が既に `serverNode.ts` / `serverCloudflare.ts` 等でアダプターを import している以上、依存の向きは変わらない（`secrets.ts` を純アプリ層に保ちたいなら、逆にアダプター側が `secrets.ts` を参照する形でもよい）。どちらにせよ**定数は1つにする**

#### Notes

- **[N-001]** **W-001 の docs 手順は実際に動く**ことを両ランタイムで確認した。Node 側は旧マイグレーションを適用済みの DB に対して現行 `migrate.node.ts` を実行し、docs が予告するとおり `SqliteError: table _occ_guard already exists` で失敗することを再現できた（メッセージまで一致）。`rm -f apps/web/data/app.db{,-wal,-shm}` 後の再実行は成功し、2回目は冪等。D1 側は `wrangler d1 migrations apply --local` 後に `.wrangler/state` の sqlite を直読みして `d1_migrations` が `{"name":"0000_initial.sql"}` を保持することを確認した — **台帳がファイル名キーである**という docs の説明（＝旧環境では silent skip）は正しい。`rm -rf apps/web/.wrangler/state/v3/d1` のパスも実在する。docs が挙げるスクリプト（`pnpm db:migrate` / `db:migrate:cf` / `deploy:aws:synth` / `deploy:aws:diff`）はすべて root `package.json` に存在する

- **[N-002]** **マイグレーション2セットにドリフトが無い。** `0000_initial.sql` はバイト一致、`_journal.json` の差は `when` のみ。`drizzle-kit generate` を両 config で回して**どちらも no-op**（4 tables / users 10 columns 2 indexes）だったので、ADR-004 が「型検査で検出できない」と警告していた「スキーマを直してマイグレーション再生成を忘れる」事故は現時点で発生していない。`libsql/__tests__/helpers.ts:19-33` が journal を走査して tag からファイルを引く実装になっており、`0000_initial.sql` をハードコードしないので、次に tag が変わっても helper は追随する（コメントにその理由も書かれている）

- **[N-003]** **CloudFront の修正は正しい。** synth 出力で `DefaultCacheBehavior.CachePolicyId = 4135ea2d-6df8-44a3-9df3-4b5a84be39ad`（Managed-CachingDisabled）と `OriginRequestPolicyId = b689b0a8-53d0-40ab-baf2-68738e2966ac`（Managed-AllViewerExceptHostHeader）を確認した。この組み合わせは「オリジンには Cookie / クエリ文字列 / Host 以外の全ヘッダを渡すが、エッジには一切載せない（min/max/default TTL がすべて 0）」であり、認証済みレスポンスがキャッシュされる経路は無い。`Host` を除外しているので API Gateway オリジンの名前解決も壊れない。`/assets/*` だけが `CachingOptimized` + S3 OAC で、こちらは Vite のハッシュ付きファイル名なので長期キャッシュが安全。`appStack.ts:237-250` のコメントが「なぜ cachePolicy を無効のままにするのか」と「なぜ originRequestPolicy が必要か」を両方書いており、次に触る人が片方だけ変えて壊す余地を減らしている

- **[N-004]** **ADR-015 の Consequences が実装と矛盾したまま残っている。** 「`bin/app.ts` の必須 env が1つ増える。**未設定のステージは synth からスキップされるだけなので、気づかず不完全なスタックが出る心配はない**」と書かれているが、W-002 の修正でこの挙動は変わり、部分設定は throw するようになった（そして「気づかず不完全なスタックが出る」ことこそがラウンド1の指摘だった）。設計記録としては、判断が更新された事実を残したほうがよい。ADR-015 に「レビュー 001 W-002 を受けて部分設定を検出する形に改めた」旨を1行追記するか、Consequences の当該文を書き換える

- **[N-005]** **`.env.aws.example` の参照先がずれている。** 「Set on the app Lambda only (see `infra/aws/lib/appStack.ts` — `appFn.environment`)」とあるが、`appFn.environment` に載るのは `SESSION_SECRET_ARN` であって `SESSION_SECRET` ではない（`appStack.ts:173-181`）。直後の `#SESSION_SECRET_ARN=` の項で正しく説明されているので誤解は解けるが、`SESSION_SECRET` の項の参照先は `apps/web/app/server.aws.ts` の `boot()`（ARN を解決して `process.env.SESSION_SECRET` に展開する地点）を指すほうが正確

- **[N-006]** **`docs/runtime_aws.md:3` の CloudFront の説明が実態より狭い。** 「API Gateway HTTP API（**and CloudFront for static assets**）」と書かれているが、ディストリビューションの**既定ビヘイビアが API Gateway オリジン**なので、`APP_URL` を `DistributionUrl` に設定した運用（同ファイル:71 が指示している）では**動的リクエストもすべて CloudFront を経由する**。今回のバグ（Cookie が転送されずログインが成立しない）が起きたのは、まさにこの経路が「静的アセット用」と認識されていたからで、修正が入った今こそ1行直す価値がある。あわせて「認証トラフィックが CloudFront を通るため、既定ビヘイビアは `CachingDisabled` + `AllViewerExceptHostHeader` の組でなければならない」を Security / Deployment のどちらかに書いておくと、次にキャッシュを有効化しようとした人が踏み止まれる

- **[N-007]** **spec と実装でテーブル名がずれている（本 PR 由来ではない）。** `spec/database/index.md` のテーブル一覧は共通基盤を `outbox` と記すが、実装は `outbox_events`（テンプレート由来）。`processed_events` / `_occ_guard` は一致している。本スライスの成果物ではないが、`spec/database/index.md` が DB 設計の正である以上、次の spec-sync でどちらかに寄せておきたい

- **[N-008]** **AC-5 の「名前付き制約6本 + インデックス2本」は数え方が曖昧。** 列挙されている名前は7つ（CHECK 5本 + ユニークインデックス2本）で、「制約6本」と一致する読み方が一意に決まらない（CHECK 5 + `users_email_uq` を制約として数えるなら6、CHECK だけなら5）。実装は spec とチェックリストの**名前の列挙**には完全に一致しているので受け入れ判定に影響は無いが、AC の文言としては「CHECK 5本 + ユニークインデックス2本」と書いたほうが検証しやすい

- **[N-009]** **CHECK 違反が `ConflictError("CONSTRAINT_VIOLATION")`（HTTP 409）になる点は据え置き**（ラウンド1 N-009）。テンプレート由来の既存挙動で本 PR の導入ではないが、CHECK が5本増えたことで初めて到達しうる。スキーマ不変条件の違反は本来アプリケーションのバグ（= `SystemError`）であってユーザーに見せる競合ではない。ただし今回 W-005 の修正で制約名まで表明するテストが d1 / libsql 両方に入ったので、**この分類を変えたときに退行が検出できる状態にはなった**。後続スライスで `SQLITE_CONSTRAINT_CHECK` を `SystemError(DataIntegrityError)` に寄せる場合、`_occ_guard` の CHECK は `isOccGuardViolation` が先に拾うので OCC 経路には影響しない

- **[N-010]** **d1 / libsql のリポジトリ実装差が `PendingBatch` の API 差だけに収まり続けている。** `toUser` / `toVersioned` / `authColumns` / `toInsertValues` / `toUpdateValues` / `findByEmail` の等値比較は完全に同型で、統合テストも意図的なミラー構成（libsql 側に「Mirrors `d1/__tests__/...`」の注記、SsoProvider を `google` / `apple` で振り分けて両方が同じ CHECK を通ることを確認）。`ExpectedVersion` の生成キャストも `toVersioned` 1箇所に閉じており（`userRepository.ts:70` / `:64`）、トークンの偽造経路を増やしていない。ドライバ固有の知識（`SQLITE_*` コード、D1 のメッセージ文字列パース、`_occ_guard` の abort 機構）はすべて `repositories/helpers.ts` と `schema.ts` に閉じていて、アダプター外へ漏れていない

- **[N-011]** **`d1/__tests__/setup.ts:27-30` の `afterEach` が良い。** `_occ_guard` を掃除するのではなく「空であること」を表明しており、「CHECK が効かなくなった」というスキーマ退行を掃除で覆い隠さない。`beforeEach` の `DELETE` に `users` が追加されている点も追随済み。ただし今後テーブルが増えたときにここへの追加を忘れるとテスト間で行が漏れるので、テーブル追加時のチェック項目として意識しておきたい
