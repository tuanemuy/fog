# レビュー 004 — Domain / Use Case / Adapters / Infra

**対象:** PR #17（`issue/1/skeleton-auth`、`fd03fa7`） / Issue #1
**ラウンド:** 4（ゼロベース再レビュー + ラウンド3指摘の解消確認）
**正とした spec:** `spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/database/index.md`
**参照:** `.thread/1/plan.md`（AC-1〜AC-8 / AC-17）、`.thread/1/adr.md`（ADR-001〜049）、`review-003-domain-adapters.md`、`triage.md`

## 検証の方法

読み合わせだけの推測と区別するため、指摘・判定の根拠にした実測を先に置く。

| 実測 | コマンド / 手順 | 結果 |
|---|---|---|
| 型検査 | `pnpm typecheck` | root + 3パッケージすべて **Done** |
| 単体テスト | `pnpm test:unit` | **25 files / 418 passed** |
| 統合テスト | `pnpm test:integration` | node **6 files / 39 passed** + cf **9 files / 104 passed** |
| lint / format | `pnpm lint` / `pnpm format:check` | エラー0（biome 設定移行を促す info 22件のみ。本 PR 由来ではない） |
| ビルド | `pnpm build` | 成功 |
| **ADR 参照の修飾率** | `grep -rnoE 'ADR-[0-9]+' packages/core/src apps/web/app infra` と `grep -v '\.thread/1/adr\.md'` | トークン **49件中47件**がパス前置。残る2件は同一行の兄弟参照（`session.ts:17` / `sessionCookie.ts:9`）で、ADR-046 の決定「1行に複数あるときは先頭だけ修飾」どおり。**無修飾の行は0件** |
| **ADR 参照先の実在** | コードが参照する {002,003,004,005,007,008,009,010,011,014,019,028,030,031,034,036,039,048,049} を `.thread/1/adr.md` の見出しと突合 | **全件実在**。内容の対応も抽出検査（ADR-009 の `passwordHasher` 例外、ADR-004 Consequences の「env スキーマは optional、必須性は消費地点で」）まで確認し、番号と主張のずれは無し |
| **`typeof` ピンの退行検出** | `DUMMY_PASSWORD_HASH_ITERATIONS: number = 210_000` と注釈して `pnpm typecheck` | `pbkdf2PasswordHasher.test.ts(243,5): error TS2578: Unused '@ts-expect-error' directive.` で**落ちる**。検出は生きている（変更は revert 済み） |
| **`Omit` の退行検出** | `ServiceArgs.container` を `UsecaseContainer` → `RequestContainer` に戻して `pnpm typecheck` | **3パッケージとも Done（落ちない）**。R3 W-008 が名指しした退行は検出されない → **W-002**（変更は revert 済み） |
| **`fromBase64Url` の空白拒否** | 実モジュールを vitest から呼ぶ | `fromBase64Url("YWJj    ")` が `[0x61,0x62,0x63]` を返して**受理される**。`fromBase64Url("YQ  ")` も受理 → **W-003** |
| **完全 ARN 正規表現と例示値** | `bin/app.ts:34` の正規表現を Node で評価 | `…:secret:turso-auth-token-a1B2c3` = true / `…:secret:session-secret-D4e5F6` = true。短縮形 `…:secret:session-secret` も **true**（bin/app.ts はその旨を明記済み、`.env.aws.example` は未追随 → N-004） |
| **`read()` の適用範囲** | `grep -rn 'process\.env' infra/aws --include=*.ts` | ヒットは `read()` 本体の**1箇所のみ**。`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` を含め全 env 読み取りが `read()` 経由 |
| **`hmacSessionCodec.ts` の外部参照数** | `grep -rn 'hmacSessionCodec' packages/core/src apps/web/app` | `di/server{Node,Cloudflare,Aws,Gcp}.ts`（`createHmacSessionCodec`）+ `di/secrets.ts`（`MIN_SESSION_SECRET_LENGTH`）+ `d1/__tests__/helpers.ts` → **JSDoc の「the one reference」は偽** → W-001 |
| マイグレーション2セットの一致 | `diff d1/migrations/0000_initial.sql libsql/migrations/0000_initial.sql` | **バイト一致** |
| スキーマの単一出所 | `diff d1/schema.ts libsql/schema.ts` | libsql 側は `export * from "../d1/schema"` の3行のみ。DDL のドリフトは構造的に起きない |
| スキーマ ↔ spec | 生成 SQL と `spec/database/index.md`「users」節を全10列 + CHECK 5本 + インデックス2本で突合 | 直和 CHECK は spec の SQL とトークン単位で一致。SQL DEFAULT を1つも置いていない点も spec どおり |
| レイヤー方向 | `grep -rn 'adapters/' packages/core/src/application`（テスト除く） / `grep -rn 'application/' packages/core/src/domain` | 前者は **`di/` 配下のみ**（4ランタイム配線 + `secrets.ts`）、後者は **0件** |
| `progress.md` の spec-sync 台帳 | `grep -n "spec-sync" .thread/1/adr.md` の全11ヒットと `progress.md:71-` を突合 | **全件転記済み**（ADR-003/005/008/009/010/011/017/018/023/024） |

## ラウンド3指摘の解消状況

| R3 ID | triage | 結論 | 根拠 |
|---|---|---|---|
| **B-001** 出荷ソースの ADR 参照が `spec/adr/` と番号衝突 | fix | **解消** | 全49トークンのうち無修飾の行は0件（実測）。判断は ADR-046 に記録され、採った案（(b) パス前置）と残る歪み（`.thread/1/adr.md` を出荷コードが参照し続ける）がトレードオフとして明記されている。散文の言い換えは3箇所（`identity.integration.test.ts:86` / `:374` / `:407`、`pbkdf2PasswordHasher.test.ts:187`）で、いずれも改行のリフローのみで意味は変わっていない |
| **W-001** `ExpectedVersion` の発行点の記述が偽 | fix | **解消** | `ports/userRepository.ts:11-14` が「the lookup methods (`findById` / `findByEmail`) as the issuers」に、`transactionalRepository.ts:6-7` が「inside their lookup methods (the only legitimate construction sites)」に、d1 / libsql の両アダプターが「the `toVersioned` helper is this adapter's only construction site」に修正済み。**主語がファイルから helper に落ちたことで d1 / libsql の両方で真になっている** |
| **W-002** CHECK 含意コメントが3本中2本で偽 | fix | **解消** | `schema.ts:43-51` が `users_auth_method_valid` だけを「Implied」とし、残る2本には「The next two are *not* implied … dropping either as "redundant" deletes the invariant」と書き分けた。指摘した反例（`sso_provider='facebook'` / `sso_provider_subject=''`）がなぜ通るかも「the sum constraint only says the SSO columns are non-NULL」と正確に説明されている |
| **W-003** `burnVerificationTime` の per-request ログ | fix | **解消** | `loginWithPassword.ts:54` のモジュールスコープ latch で isolate ごとに1回に絞られた。判断は ADR-047 に記録され、「Logger デコレータ案を採らなかった理由」「ラッチ後は回数が分からない」「プロセス再起動まで降りない」の3点がトレードオフとして書かれている（残課題 → N-001） |
| **W-004** 生の例外を logger へ渡す | fix | **解消** | (a)(b) 両方採用。`ports/passwordHasher.ts:15-21` に禁止条項が入り（「must not carry a `PlainPassword` in its message, its `cause` or any nested field」）、`loginWithPassword.ts:87` が `cause instanceof Error ? cause.name : typeof cause` の非推移的射影になった。**射影は非推移的であることを実測確認**（`Error.name` は `string`、入れ子を持たない） |
| **W-005** `one-file change` の JSDoc | fix | **部分解消 → 新 W-001** | 該当文は「touches this file plus the one place outside it that reads `MIN_SESSION_SECRET_LENGTH`」に直った。ただし同時に追加された `:17-19` の「That is the one reference to this file from outside the adapter」が新たに偽になっている |
| **W-006** `read()` の適用漏れ | fix | **解消** | `bin/app.ts:19-20` が `read()` 経由に。`process.env` の直接参照はファイル内で `read()` 本体の1箇所のみ（実測）。コメントも「Every env read in this file goes through here」と実態に追随している |
| **W-007** 完全 ARN 正規表現 | fix | **解消** | `.env.aws.example` の例示値2つが6文字サフィックス付きの完全 ARN になり、両方とも正規表現を通る（実測）。あわせて `bin/app.ts:28-32` に「This is a heuristic, not a decision procedure」と、名前がハイフン+6英数で終わる部分 ARN は通ってしまう旨が明記された（残る記述差 → N-004） |
| **W-008** 型ガードの退行検出 | fix | **半解消 → 新 W-002** | 反復回数ピン側は**実測で機能**（`: number` 注釈で `TS2578` により型検査が落ちる）。`UsecaseContainer` 側は**実測で機能しない** — 指摘が名指しした「`ServiceArgs.container` を `RequestContainer` に戻す」変更で型検査が通ってしまう |
| **W-009** `progress.md` の spec-sync 取りこぼし | fix | **解消** | `grep -n "spec-sync" .thread/1/adr.md` の全11ヒットが `progress.md:71-` に転記済み（実測で突合）。「台帳は記憶ではなく grep から作る」という運用そのものが節の冒頭に書かれており、再発防止の形になっている |

**判定 `fix` の R3 指摘で完全に未解消のものは無い。** 以下の Warning 3件は、うち2件が R3 の修正が新たに生んだもの、1件が R2 で「解消」と判定されたが実測すると成立していなかったものである。

## 受け入れ基準の検証結果

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1（VO の制約・`BusinessRuleError<IdentityErrorCode>`） | **満たす** | `valueObject.ts` の8 VO + `Actor` がすべて `unique symbol` ブランド + `create`。UserId（trim 後非空）/ Email（正規化 + `local@domain` + 320）/ PlainPassword（8〜128、非 trim）/ PasswordHash（非空）/ SsoProvider（`google`\|`apple`）/ ClientName（trim 後非空・100）/ TrashRetentionDays（整数 >= 1、`default()` = 30）/ AiClientConnectionId が spec と一致。長さは `codePointLength`（ADR-023） |
| AC-2（`PasswordUser \| SsoUser` と4ファクトリ） | **満たす** | `entity.ts:14-34` が spec のフィールド表と1対1。4ファクトリとも `now` / `id` を引数で受ける純関数で `new Date()` / ID 生成なし。`changePassword` は `PasswordUser` 限定（`entity.test.ts` の `@ts-expect-error`） |
| AC-3（識別子なしドラフト＋同一トランザクション outbox） | **満たす** | `events.ts` の `IdentityEvents` が `EventDraft`（`id` なし）を返す。`registerWithPassword.ts:56` の `collectEvents` が唯一の経路で、`UnitOfWorkContext` は `userRepository` と `collectEvents` しか露出しない |
| AC-4（ポートの宣言と OCC 規約） | **満たす** | `ports/userRepository.ts:38-43` が4メソッド。`TransactionalRepository` を extends しない理由も JSDoc にある。`save` の WHERE は `id = ? AND version = ?`、0行更新は `_occ_guard` で batch 全体を abort（d1 / libsql とも）。**R3 W-001 で指摘した記述の誤りは解消済み** |
| AC-5（`users` の名前付き制約 + インデックス2本、共通基盤3テーブル） | **満たす** | 生成 SQL に CHECK 5本 + `users_email_uq` + 部分一意 `users_sso_identity_uq`。共通基盤は `outbox_events`（`idx_outbox_pending` 部分索引つき）/ `processed_events` / `_occ_guard`。d1 / libsql はバイト一致で、スキーマ本体は d1 の再エクスポート1本 |
| AC-6（d1 / libsql 両実装、OCC / 不整合行 / 翻訳点） | **満たす** | `toUser` は行オブジェクトをそのまま `User.reconstruct` に渡すので列の取り違えが構造的に起きない。`RehydrationError` → `SystemError(DataIntegrityError)`、`SQLITE_CONSTRAINT_UNIQUE`/`_PRIMARYKEY` → `UNIQUE_VIOLATION`、それ以外の制約 → `CONSTRAINT_VIOLATION`、非制約 → `SystemError(DatabaseError)`。`EMAIL_ALREADY_REGISTERED` の翻訳点はユースケース境界で、`registerWithPassword.ts:68-74` が安全性の前提（この UoW が書くのは users 1件 + outbox 1件だけ）を列挙している |
| AC-7（タイミングセーフ照合、不一致は `false`） | **満たす** | `pbkdf2PasswordHasher.ts:185-189` が `timingSafeEqual`（`encoding.ts:65-70`、短絡なし）で比較し `boolean` を返す。throw は `CryptoError` と `DataIntegrityError` のみで両方にテストがある |
| AC-8（4ユースケースの処理フローとエラー契約） | **満たす** | 下表 |
| AC-17（typecheck / lint / format / test の通過と起動導線） | **満たす** | 全4コマンドを実測で通過。加えて `pnpm build` も成功。`pnpm db:migrate` / `pnpm dev` は本レビューでは未実行（`.thread/1/testing.md` の手動検証の担当範囲） |

**AC-8 の処理フロー突き合わせ**

| ユースケース | spec | 実装 | 判定 |
|---|---|---|---|
| `registerWithPassword` | clock/idGen → VO → UoW 外で hash → UoW 内で `findByEmail` → `insert` → `collectEvents` | `registerWithPassword.ts:38-58` が同順。`catch` は `code === "UNIQUE_VIOLATION"` 限定 | 一致 |
| `loginWithPassword` | 全失敗を `ValidationError("INVALID_CREDENTIALS")` に統一 | `:119 / :131 / :141 / :148` の4分岐すべてが `invalidCredentials()` 単一ファクトリ。統合テスト `:550-582` が5経路の `toSerialized()` の相互一致を表明 | 一致（時間の同一化は spec の要求を上回る） |
| `logout` | ドメイン操作なし・`void` | `logout.ts:21-25`。`UserId.create` のみ（ADR に記録済みの字面差） | 一致 |
| `getCurrentUser` | `UserId.create` → `findById` → 資格情報・SSO 主体を含めない平坦 view | `getCurrentUser.ts:21-32` + `view.ts:12-26`。`CurrentUserView` は `{ userId, email, authMethod, trashRetentionDays }` のみ | 一致 |

読み取り専用ユースケースが `unitOfWorkProvider.run` を通る点は spec の「UoW 不要」と字面が異なるが、ADR-009 のとおり純読み取り UoW はトランザクションを張らないので実質は満たしている（spec-sync 台帳に転記済み）。

## 重点観点の検証結果

- **レイヤー分離と依存方向** — アプリケーション層からアダプターへの import は `di/` 配下のみ（実測）。`domain` からアプリケーション層への import は0件。逆向き（アダプター → アプリケーション）は既存の翻訳目的の import 群に加えて `pbkdf2PasswordHasher.ts:2` の1本だけで、これは `import type` なので実行時のエッジは生じない。**合格**（所在の妥当性 → N-008 の (f)）
- **不正な状態の型表現** — `SessionSecret` ブランド、`UsecaseContainer` の `Omit`、`DEFAULT_PBKDF2_ITERATIONS` の literal ピン、`changePassword` の `PasswordUser` 限定と、この PR は型で止める判断を積み上げている。ただし**そのうち1本（`Omit`）は退行検出が効いていない**（実測 → W-002）。**条件付き合格**
- **ドメイン純粋性** — `domain/identity/` と `domain/common/text.ts` に I/O・`new Date()`・ID 生成は無い。**合格**
- **UoW 規約 / クロスレイヤー catch** — 書き込みは `run` の中だけ。明示された catch は `registerWithPassword.ts:61-79`（`UNIQUE_VIOLATION` 限定）、`loginWithPassword.ts:115-120`（VO 生成2行だけ）、`:80-89`（ダミー verify の握り潰し・ログ付き）の3箇所で、いずれも CLAUDE.md の「明示された境界のみ」に収まる。ドメインエラーの再翻訳は無い。**合格**
- **リポジトリ実装の正しさ** — 再水和は行をそのまま `reconstruct` に渡す形で、`ReconstructInput` の10フィールドと `UserRow` が名前・null 許容・`Date` 射影まで一致。OCC トークンの `as` キャストは `toVersioned` の1箇所に閉じている。`OCC_GUARD_CHECK_NAME` は schema から共有され名前 drift が起きない。**合格**
- **暗号アダプターの正しさ** — `parse()` は `/^\d+$/` で反復回数を読み、整数・下限1・上限 `MAX_PBKDF2_ITERATIONS` を検査してから `derive` に渡す。`verify` は保存値の宣言コストで導出してから `timingSafeEqual`。`hmacSessionCodec.verify` は `crypto.subtle.verify` の後に `exp` を見るので、署名前に payload を信用する経路が無い。**合格**
- **JSDoc の質** — R3 で指摘した4件（B-001 / W-001 / W-002 / W-005）のうち3件は実態と一致する記述に直り、`schema.ts:47-51` と `ports/passwordHasher.ts:15-21` は特に良い。**一方で、実測すると成立しない記述が3件残っている**（W-001 / W-002 のコメント / W-003）。4ラウンド連続で同じクラスの問題が出ており、依然この PR の弱点である。ただし残る3件はいずれも**振る舞いではなく記述だけ**の問題で、指す先も1〜2行に限定されている

---

### Domain / Use Case / Adapters / Infra

#### Blockers

なし

#### Warnings

- **[W-001]** `hmacSessionCodec` の JSDoc「`secrets.ts` からの参照がこのファイルへの唯一の外部参照」が偽。**同じファイルの `createHmacSessionCodec` を4本の DI 配線が import している**
  - 場所: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:17-19`（"That is the one reference to this file from outside the adapter, and replacing the codec means replacing it too."）/ 波及は `:52-55`（"Swapping in a table-backed codec later touches this file plus the one place outside it that reads {@link MIN_SESSION_SECRET_LENGTH}"）
  - 理由: 実測した。`adapters/webcrypto/` の外からこのファイルを参照しているのは —
    `application/di/serverNode.ts:9` / `serverCloudflare.ts:10` / `serverAws.ts:10` / `serverGcp.ts:5`（いずれも `createHmacSessionCodec`）、`application/di/secrets.ts:5`（`MIN_SESSION_SECRET_LENGTH`）、`adapters/d1/__tests__/helpers.ts:11` の**計6本**である。「唯一の外部参照」は5本を数え落としている。
    波及のほうがより実害に近い。`:52-55` は「テーブル方式の codec に差し替えるとき触るのは、このファイル＋定数を読む1箇所」と読者に約束するが、実際には**4本の DI ファクトリが `createHmacSessionCodec` を名指しで呼んでいる**ので、差し替えは必ずその4本の編集を伴う。R3 W-005 は「`one-file change` が ADR-036 の修正で成立しなくなった」ことを指摘したもので、その修正でこの文は「1ファイル → 2ファイル」に緩められたが、**もともと数え落としていた4本は今回も数えられていない**。ADR-036 の Consequences も「この import 先も差し替え対象になる」としか書いておらず、同じ穴が空いている
  - 提案: `:17-19` は「`MIN_SESSION_SECRET_LENGTH` を読む唯一の外部参照は `application/di/secrets.ts` である」と、主語を**ファイルから定数**に落とせば真になる。`:52-55` は「codec の差し替えはこのファイルと、`createHmacSessionCodec` を呼ぶ4本の DI 配線、および `MIN_SESSION_SECRET_LENGTH` を読む `secrets.ts` に閉じる — ポートの呼び出し側は何も変わらない」と、閉じる範囲を「合成ルート＋この定数」と述べる形にしたい。主張したい本質（「port の consumer は影響を受けない」）はそのまま残る

- **[W-002]** `UsecaseContainer` に足した `@ts-expect-error` が、**そのコメント自身が名指しした退行を検出しない**。実測で確認した
  - 場所: `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts:89-101`（"nothing else would fail if `ServiceArgs.container` were widened back to `RequestContainer`. The directive below is the whole assertion: it goes unused the moment the codec becomes reachable"）
  - 理由: 実測手順と結果 — `packages/core/src/application/types.ts:16` を `container: UsecaseContainer` → `container: RequestContainer` に書き換えて `pnpm typecheck` を回すと、**root + 3パッケージすべて Done で通る**（変更は revert 済み）。理由は単純で、このテストが参照しているのは型エイリアス `UsecaseContainer` そのものであり、`ServiceArgs.container` がどちらを指すかには一切触れていないからである。`UsecaseContainer` の定義（`Omit<RequestContainer, "sessionCodec">`）が残っている限り `c.sessionCodec` は型エラーのままで、ディレクティブは使われ続ける。
    つまりこの2行が固定しているのは「`Omit` が `sessionCodec` を落とすこと」だけで、**「ユースケースが受け取るのが `UsecaseContainer` であること」は固定していない**。R3 W-008 が求めたのは後者（「`ServiceArgs.container` を `RequestContainer` に戻す変更を止めるものが何も無い」）であり、そこは埋まっていない。同じテストファイルで隣に置かれた反復回数ピンのほうは実測で機能している（`: number` 注釈で `TS2578` により型検査が落ちる）ので、**2本のうち1本だけが空振りしている**状態である。加えてコメントの「nothing else would fail if `ServiceArgs.container` were widened back」は、直後の「The directive below is the whole assertion」と併せて読むと「このディレクティブがそれを止める」と読めるが、実際には止まらない
  - 提案: 対象を型エイリアスではなく**ユースケースが実際に受け取る引数**に変える。1行の差し替えで両方が固定できる。
    ```ts
    // @ts-expect-error usecases must not be able to reach the session codec
    const reach = (a: ServiceArgs<unknown>) => a.container.sessionCodec;
    ```
    これなら `ServiceArgs.container` が `RequestContainer` に戻った瞬間にディレクティブが unused になって型検査が落ちる。`UsecaseContainer` の `Omit` が外れた場合も同じく落ちるので、現行の表明の範囲も失われない。コメントの「nothing else would fail …」もそのまま真になる

- **[W-003]** `fromBase64Url` の「空白は拒否される」という記述が偽。**長さが4の倍数に収まる空白は受理される**。R2 で「解消」と判定された JSDoc に残っていた誤り
  - 場所: `packages/core/src/adapters/webcrypto/encoding.ts:49-52`（"embedded whitespace and redundant `=` push the result off a multiple of four and `atob` refuses it"）/ 同趣旨の記述が `__tests__/encoding.test.ts:75-79`（"a whitespace-bearing or over-padded string lands off a multiple of four and is refused"）
  - 理由: 実測した。実モジュールを vitest から直接呼んだ結果 —

    | 入力 | 長さ | 結果 |
    |---|---|---|
    | `"YWJj "` | 5 | throw（テストが固定しているケース） |
    | `"YW Jj"` | 5 | throw（同上） |
    | **`"YWJj    "`** | **8** | **受理。`[0x61,0x62,0x63]` を返す** |
    | **`"YQ  "`** | **4** | **受理。`[0x61]` を返す** |

    パディングは `padEnd(Math.ceil(len/4)*4, "=")` で入力長から計算されるので、**空白を含んだ状態で既に4の倍数なら padEnd は何も足さず、`atob` が自分の規則で空白を読み飛ばして通す**。「空白は4の倍数を外すから拒否される」という因果は、たまたま長さが4の倍数を外す入力についてしか成り立たない。`encoding.test.ts:80-87` の4ケースはいずれも長さ5または9で、**成り立つ側だけを固定している**。
    セキュリティ影響は無いことも確認した — 署名対象は `encoder.encode(payloadPart)`（生の文字列）なので payload 側に空白を足せば署名が合わなくなり、signature 側に足しても復号バイト列は同じで偽造にはならない。問題は契約の記述であって挙動ではない。ただしこの JSDoc は R2 adapters W-002 で「実態より広い保証を書いている」と指摘されて書き直され、R3 が「理由まで正確」と評価して閉じたものである。**2ラウンド続けて記述が実測されずに承認された**箇所なので、ここで閉じておきたい
  - 提案: 実測に合わせる。「パディングを入力長から計算するため、長さが4の倍数を外す空白・余剰 `=` は `atob` に拒否される。一方、長さが4の倍数に収まる空白（`"YWJj    "`）は `atob` 自身の寛容さで通る — 受理集合は `atob` より狭いが、空白を一律に排除するものではない」。テスト側も `it("accepts whitespace that keeps the length a multiple of four")` を1件足して、境界の両側を固定したい。`:42-47` の「a token string must never be treated as a canonical identity」はこの事実をむしろ補強するので、そのままでよい

#### Notes

- **[N-001]** `burnVerificationTime` のラッチ（`loginWithPassword.ts:54`）は妥当な設計だが、**振る舞いを表明するテストが1件も無い**。`grep "Login timing equalisation"` のヒットは実装1件のみで、「1回だけ出る」ことも「2回目は出ない」ことも検証されていない。ラッチを踏む唯一のテスト（`identity.integration.test.ts:679`）は例外が握り潰されることだけを見ており、ログには触れない。R2 adapters W-003 が「フェイルクローズの拒否側が1件も踏まれていない」を理由に修正を求めた基準を、今回追加した抑制ロジックには当てていないので対称性を欠く。`vi.resetModules()` + 動的 import で決定的に書けるので、無理のあるテストではない。あわせて (a) モジュールスコープの可変状態は CLAUDE.md「application 層は stateless」とわずかに緊張する（ADR-047 が明示的に受け入れている）、(b) JSDoc `:66-67` は "once per process"、直上のインラインコメント `:53` は "once per isolate" と粒度の呼び方が揺れている（CF では後者が正確）、(c) 他のログ（`[relay]` / `[queue]` / `[outbox]`）が持つタグ接頭辞がこの1本だけ無い、の3点も小さく残る。

- **[N-002]** 反復回数ピンの退行検出テスト（`pbkdf2PasswordHasher.test.ts:242-247`）は実測で機能しているが、**ドリフト値に `600_000` を使っているため、将来ワークファクターを正確に `600_000` へ引き上げると偽陽性になる**。そのとき `typeof DEFAULT_PBKDF2_ITERATIONS` は `600000` になり、`const drifted: 600000 = 600_000` が通って `@ts-expect-error` が unused → 型検査が落ちる。落ちた人はテストを見れば理由が分かるので実害は小さいが、`600_000` を「現実的な次の値」ではない値（`1` や `123` など）にしておけば衝突しない。

- **[N-003]** `users_sso_identity_uq` を部分インデックスにした理由の説明が誤っている（R3 N-004 の再掲・未対応）。`schema.ts:65-66` は「Partial: `PasswordUser` rows leave both SSO columns NULL and **must not collide with each other**」と書くが、SQLite の UNIQUE インデックスは NULL を互いに相異なるものとして扱うので、`WHERE sso_provider IS NOT NULL` が無くても `(NULL, NULL)` 行同士は衝突しない。部分化の実利はインデックスサイズと意図の明示であって衝突回避ではない。**スキーマ自体は spec どおりで正しい**ので直すのは理由の記述だけ。W-002（R3）で `schema.ts` の別のコメントを実測ベースに直した際、同じファイルの2行下にあるこれが対象に入らなかった形になる。

- **[N-004]** `apps/web/.env.aws.example:55-57` の「`infra/aws/bin/app.ts` rejects an ARN truncated at the name」が、`bin/app.ts:28-32` に今回追加された但し書きと食い違う。実測すると `…:secret:session-secret`（＝この修正で置き換えられた**旧・例示値そのもの**）は正規表現を **通る**。ヒューリスティックであることを書いたファイルと、断定形で「拒否する」と書いたファイルが分かれている状態なので、`.env.aws.example` 側を「名前が `-` + 6英数で終わる場合は検出できない」と1節足すか、単に「完全 ARN を使うこと」に留めるかで揃えたい。

- **[N-005]** 前ラウンドから未対応のまま残っている記述の追跡（いずれも triage に上がっていないので必須ではない）。
  (a) `apps/web/.env.aws.example:29-31` が `SESSION_SECRET` の参照先を「`infra/aws/lib/appStack.ts` — `appFn.environment`」と書くが、そこに載るのは `SESSION_SECRET_ARN`（`appStack.ts:181`。実測で `SESSION_SECRET` の直接設定は無い）。正確には `apps/web/app/server.aws.ts` の `boot()` を指す（R3 N-010b）。
  (b) `valueObject.ts:42` の「Length is capped at the RFC 5321 path limit」— RFC 5321 の 320 はオクテット上限だが実装はコードポイント計測（ADR-023）。ASCII アドレスでは差が出ない（R3 N-002）。
  (c) `entity.ts:196-197` の `reconstruct` が `createdAt` / `updatedAt` を素通しする。ほかの4フィールドが再検証される中でここだけ検証が無く、`new Date(NaN)` を持った `User` が組み上がりうる（R1 W-003 → R3 N-003 と3度目）。`Number.isNaN(date.getTime())` を見るだけで粒度が揃う。**据え置きが判断なのかを一度確定させたい**。
  (d) `d1/pendingBatch.ts:43-47` の OCC ハンドラ帰属コメントが誤っている（`firstConflictHandler()` は常に `conflictHandlers[0]` を返すので「最初に失敗した文」ではない）。本 PR 由来ではなく、1 UoW に2件の OCC 書き込みを行うユースケースが存在しないため現状到達不能（R3 N-005）。
  (e) `DUMMY_PASSWORD_HASH` が `PasswordHash.create(...)` ではなく `as PasswordHash` の生キャストで作られている（`loginWithPassword.ts:45-46`。R2 N-001 → R3 N-001）。
  (f) `application/di/` が合成ルートである旨が CLAUDE.md「Layers」節に書かれていないため、`architecture-audit` を回すと `secrets.ts:5` と4本のランタイム配線が違反として拾われる（R3 N-007）。
  (g) `infra/gcp/example/services/main.tf:36-43` だけセッション鍵の受け渡しが平文 env で、AWS の Secrets Manager 経由と非対称（R3 N-009）。

- **[N-006]** `.thread/1/adr.md` の採番が **ADR-043 の次に ADR-046** へ飛んでおり、044 / 045 が欠番。コードからの参照は無いので実害は無いが、ADR-046 が「番号空間を一意に解決させる」ことを決めた文書である以上、その台帳自身に穴がある形になっている。欠番である旨を1行書くか詰めるかしておきたい。

- **[N-007]** `Logger` ポートの慣例コメント（`ports/logger.ts:6`「callers put the underlying error under a `cause` key」）に対し、`loginWithPassword.ts:87` は `cause` キーに **`Error` ではなく文字列**（`cause.name` / `typeof cause`）を入れる。W-004 の対応として意図的で、その理由は JSDoc `:69-73` に正しく書かれている。構造化ログのシリアライザが `cause` を `Error` 前提で処理していると型が揺れうるので、ポート側の慣例コメントに「値の型は呼び出し側の判断（機微を含みうる経路では射影してよい）」と1行添えると、慣例と例外の関係が読み手に伝わる。

- **[N-008]** アダプターがユースケースのモジュールから型を import している（`pbkdf2PasswordHasher.ts:2` → `application/identity/loginWithPassword`）。向きは内向きで `import type` なので実行時の依存は生じないが、汎用の暗号アダプターが特定の1ユースケースのファイルに結び付いている（R3 N-006）。第2の消費者が現れた時点で `application/ports/passwordHasher` 側の定数として括り出す形を検討したい。

- **[N-009]** 未実装の spec 要素は前ラウンド同様 `plan.md` のスコープ節と一致していることを再確認した: `UserRepository.findBySsoIdentity`、`TokenScope`、`AiClientConnection` 一式、`IdentityErrorCode.PasswordNotSupported`、`SSO_IDENTITY_ALREADY_REGISTERED` の翻訳。等時間化により未登録アドレスへのログイン試行も本物と同じ CPU を払うため、Issue #18 のレート制限の優先度は上がったままである。
