# ADR — Issue #37: D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

`.thread/34/design.md` と `spec/database/index.md` で確定済みの判断は**ここに再掲しない**。本ファイルに書くのは、それらを読んでもなお #37 の実装者が決めなければならない判断だけである。

## ADR-001: #37 が実装するのは「DDL + projection モジュール + ジョブ実行部」までで、memo / knowledge ドメインは作らない

### Status

Proposed

### Context

Issue の受け入れ条件は「メモ・ドキュメントの作成・編集・削除・復元と FTS5 インデックスが同一 transaction で整合する」「trash retention が Alarm で動作する」を要求する。ところが memo / knowledge / trash / search のドメイン層は1行も実装されておらず（`.thread/34/design.md` 第2.3節）、その実装は #2〜#10 の担当である。素直に読むと #37 が memo / knowledge のエンティティ・値オブジェクト・リポジトリ・ユースケースまで作ることになり、後続 Issue と正面から重複する。

一方 Issue 本文の対応項目4 は「検索 usecase と検索ページの実装は #10 の担当。本 Issue はその土台となる **DO 内 FTS5 schema と同期 projection まで**を提供する」と明記している。

### Decision

- **21テーブルの DDL は全数作る。** `spec/database/index.md` が正本で、索引もテーブル新設と同じ `transactionSync` で張る（第9.2節 条件4 の回避策 (a)「索引は原則としてテーブル新設時に同時に張る」）。
- **FTS5 の書き込みは projection モジュールとして置く。** `.adr/005` が「索引の更新は本体を書くリポジトリ実装が同じトランザクションの中で行う projection 処理である」と決めているので、その実体である関数を #37 が提供し、#2〜#6 のリポジトリが呼ぶ形にする。
- **`purge-trash` ジョブは `memos` / `topics` / `documents` の行に対して直接実装する。** `HardDeletePolicy` は未実装なので、展開規則（トピックはセットの配下も対象）はジョブ実行部が持つ。第7.5節が「ハードデリートのロジックは DO 内のジョブ実行部へ移る」と書いているとおりで、`HardDeletePolicy` が実装されたら呼び出しに差し替える。
- **memo / knowledge のエンティティ・リポジトリ・ユースケースは作らない。** **Issue の受け入れ条件5（FTS5 と同一 transaction）と受け入れ条件7（trash retention が Alarm で動作）** の検証は、projection モジュールとジョブ実行部に対する DO 統合テスト（本体行の書き込みと projection を同一 `transactionSync` で発行し、コミット後に両方が変わっていること／ロールバック時にどちらも変わっていないこと）で行う。**番号は「受け入れ条件N」と書き、`plan.md` の `AC-N` と混同しない**（`plan.md` の AC-5 は UoW の同期契約、AC-7 が FTS5 の同一トランザクションである。同じ文書群で2つの番号体系が同じ表記を使うと、件数と全数を機械的オラクルにする本計画の方針が壊れる）。

### Consequences

- 良い点: #2〜#10 との重複がゼロになる。受け入れ条件が求めている「同一トランザクションで整合する」という**構造**は、それを守る唯一の実装点（projection モジュール）に対して検証される。
- トレードオフ: 受け入れ条件5 の検証がユースケース経由ではなくアダプター経由になる。「メモを作成する」というユーザー操作としての E2E は #2 まで存在しない。
- トレードオフ: **`projection.ts` を呼ぶ義務の履行者が #37 に存在しない。** #2〜#6 のリポジトリが呼び忘れても `plan.md` の AC-7 は緑のままで、「例外を上げずに索引だけ黙って壊れる」というリスクを #37 側では回収できない。**`projection.ts` の JSDoc に「索引への唯一の書き込み点」と明記したうえで、呼び出し側の義務を #2〜#6 へ外部コメントで引き継ぐ**（steps.md ステップ30 の外部アクション (e)）。
- トレードオフ: `purge-trash` の展開規則が一時的に2箇所（ジョブ実行部と、将来の `HardDeletePolicy`）に現れる可能性がある。#7〜#9 が `HardDeletePolicy` を実装するときに1箇所へ寄せる。

---

## ADR-002: `jobs.kind` は12種を型で宣言し、ハンドラと投入点は7種だけ実装する

### Status

Proposed

### Context

`spec/database/index.md` と第7.4節が `kind` の全数を12種と宣言し、`.adr/010` が「投入点の欄が空でないことを不変条件とする」と定めている。しかし12種のうち5種（`finalize-withdrawal` / `resume-link` / `resume-credential-change` / `sweep-orphan-mapping` / `rotate-encryption`）が前進させる手続き — 退会・SSO link / unlink・credential 変更・鍵ローテーション — は #12 / #44 / #45 の担当であり、#37 には投入点となるユースケースが存在しない。

全数を型から落とすと `.adr/010` の不変条件が検査できなくなり、逆に未実装のハンドラを登録するとジョブランナーが未知の `kind` を `poison` にする経路が開く。

### Decision

- **`packages/core/src/lib/jobKind.ts` に12種すべてを union として宣言し、所有 DO クラスと再武装分類（A / B / C）を同じ表として持つ。** 型と表は全数のまま落とさない。
- **ハンドラレジストリに登録するのは7種**（`purge-trash` / `send-mail` / `sweep-reset-tokens` / `sweep-reservations` / `resume-signup` / `reindex` / `migrate-bulk`）である。
- **レジストリのキー集合は所有 DO クラスで型拘束する。** `JOB_OWNER` から導いた条件型（`JobKindOf<D extends DoClass>`）でキーを絞り、`Partial<Record<JobKind, …>>` にしない — 後者だと `send-mail`（Identity Directory 所有）を User Data 側のレジストリへ登録できてしまう。`CLAUDE.md`「Make illegal states unrepresentable at the type level before falling back to runtime checks」に従う形であり、下の単体テストも**所有クラス別（User Data 3 / Identity Directory 4）に割った形**で書ける。
- **未登録の `kind` の行は #37 のコードでは1行も作られない**（投入点が存在しないため）。ランナーは未登録 `kind` に遭遇したら `terminalReason: "UNIMPLEMENTED_JOB_KIND"` で `poison` にする — これは将来の実装漏れを検出するための fail-closed であって、平常時には到達しない。
- 単体テストで「12種の union の要素数が12であること」「ハンドラレジストリのキー集合が上の7種と一致すること」を固定する。

### Consequences

- 良い点: `.adr/010` の全数宣言が型として残り、#12 / #44 / #45 がハンドラを足すときに表を直す義務が明示される。
- トレードオフ: 「宣言されているのに実装されていない `kind`」がレジストリの差分として5件残る。テストがその件数を固定するので、黙って増減しない。

---

## ADR-003: UoW コンテキストを DO クラスごとに2型へ分ける

### Status

Proposed

### Context

`.thread/34/design.md` 第8.2節の `UnitOfWorkContext` は1つの interface として書かれているが、コメントで「Directory bucket 側は `credentialMappingRepository`」「`credentialLocatorStore` は User Data DO」「`resetTokenStore` / `rotationCheckpointStore` は Identity Directory DO」と注記している。CLAUDE.md も「the non-aggregate stores — **whose roster differs by DO class**」と明記し、`recordOperation` / `updateOperation` / `setMigrationCursor` は User Data DO にしか無いと書いている。

単一の型にすると、Directory bucket の中で `credentialLocatorStore` を触るコードが型検査を通ってしまう。存在しないテーブルへの書き込みは実行時に初めて落ちる。

### Decision

`packages/core/src/application/execution/unitOfWork.ts` に**2つのコンテキスト型**を置く。

```ts
export interface UserDataUnitOfWorkContext {
  userSettingsRepository: UserSettingsRepository;
  accountStore: AccountStore;
  credentialLocatorStore: CredentialLocatorStore;
  enqueueJob(args: EnqueueJobArgs): void;
  recordOperation(args: RecordOperationArgs): void;
  updateOperation(operationId: string, patch: OperationPatch): void;
  setMigrationCursor(targetVersion: number, step: number, cursor: string): void;
}

export interface IdentityDirectoryUnitOfWorkContext {
  credentialMappingRepository: CredentialMappingRepository;   // 読み3本
  credentialMappingStore: CredentialMappingStore;             // 書き7本（ADR-012）
  resetTokenStore: PasswordResetTokenPort;
  rotationCheckpointStore: RotationCheckpointStore;
  enqueueJob(args: EnqueueJobArgs): void;
}

export interface UnitOfWorkProvider<TContext> {
  run<T>(fn: (ctx: TContext) => T extends Promise<unknown> ? never : T): T;
}
```

`enqueueJob` だけが両方に現れる（`spec/database/index.md`「非集約ストアへの書き込み口」の6ストア・7メソッドを、`_meta` を除いて DO クラスへ分配した形と1対1である）。**`credentialMappingStore` はこの数え方の外である** — `credential_mappings` は同ファイルの分類表で「非集約ストア7つ」ではなく「CAS で直列化」という独立区分に置かれているためで、全数は崩れない（ADR-012）。

### Consequences

- 良い点: DO クラスごとの書き込み口の全数が型として現れ、`spec/database/index.md` の表と機械的に突き合わせられる。
- 良い点: `.adr/008` が言う「ポート本数は増えるが、上位の層が使う名前がすべてドメイン側にアンカーを持つ」がそのまま型に写る。
- トレードオフ: `UnitOfWorkProvider` がジェネリックになる。呼び出し側は DO クラスごとに別のプロバイダを受け取る。

---

## ADR-004: チューニング定数を `packages/core/src/lib/` の leaf モジュールに置く

### Status

Proposed

### Context

#40 のクローズコメント §3 と第7.4節末尾が名指しで要求している。現行の `application/di/env.ts` が `application/workers/eventRelayWorker.ts` から `DEFAULT_*` を value-import しており、「合成ルート（di）→ worker 実装」という逆向き依存を作っていた。その value-import が、トップレベル Worker が module-scope の `crypto.randomUUID()` を評価してしまう唯一の流入経路だった。新しい設計は同種の定数（3階層予算・最小再開間隔・prune 保持期間・lease 期限）を再導入する。

### Decision

- **`packages/core/src/lib/jobBudgets.ts` を新設し、import を1つも持たない leaf モジュールにする。** 置く値は `MAX_JOBS_PER_ALARM = 25` / `DEFAULT_MAX_CHUNKS_PER_JOB = 20` / `DEFAULT_CHUNK_ROW_LIMIT = 1000` / `MIN_RESUME_INTERVAL_MS` / `DEFAULT_LEASE_MS` / `DONE_RETENTION_MS` / `POISON_RETENTION_MS` / `SEND_MAIL_EMPTY_RETENTION_MS` / `PRUNE_ROW_LIMIT` と、`kind` ごとの `(chunkRowLimit, maxChunks)` の表。
- **`packages/core/src/lib/jobKind.ts` も同じく leaf** にする（`JobKind` union と所有 DO クラス・再武装分類の表）。
- **DI（`application/di/*`）と DO の実行部は、この2ファイル以外から定数を value-import しない。** 逆に、実行部モジュールが `DEFAULT_*` を export する形を禁止する。
- 実際の運用値の確定は #38（第11.3節の2段分担）。#37 は spike で根拠値を出して初期値として置く。

### Consequences

- 良い点: 合成ルートが実行部モジュールを推移的に評価する経路が構造的に消える。#40 の再発が同じ形では起きない。
- 良い点: leaf なので unit テスト（Node プール）から直接読める。
- トレードオフ: 「値がどのジョブのためのものか」が実装から離れる。表のキーを `JobKind` で型付けして対応を落とさない。

---

## ADR-005: 起動スモークテストを Workers プール統合スイートとは別レイヤーとして置く

### Status

Proposed

### Context

#40 のクローズコメント §4 が要求している。`@cloudflare/vitest-pool-workers` はテストモジュールをハンドラ相当のコンテキストで評価するため、workerd の global scope 制約（乱数・非同期 I/O・タイマー）にそもそも当たらない。#40 は型検査・lint・統合テストのいずれでも検知できなかった。DO 移行は Worker のモジュールグラフを大きく組み替えるので、移行中の安全網としても要る。

`.adr/001` は「統合テストを Workers プール1本に集約する」と決めているので、**そこへ足すのではなく別レイヤーであることを明示する必要がある**。

### Decision

- **`vitest.config.smoke.ts`（Node プール）を新設し、`miniflare` パッケージを直接使って `scriptPath` にビルド成果物を渡し `dispatchFetch` する。** 対象は request Worker（`dist/server/index.js`）と state Worker（`dist/state/index.js`）の2本である。
- 実行は `pnpm test:smoke`（前段で `pnpm build:cf` が必要）。CI の build ジョブの末尾に足す。
- **`.adr/001` の「Workers プール1本」は統合テストについての決定であり、本スイートはそれに含まれない**旨を `vitest.config.smoke.ts` の冒頭コメントと `.adr/001` の影響欄への追記で明示する。
- 検知対象は `crypto.randomUUID()` に限らず、global scope での `setTimeout` / `fetch` を含む。

### Consequences

- 良い点: workerd の起動時制約が CI で検知できるようになる。`pnpm start` / `pnpm preview` の回帰も同時に塞がる。
- トレードオフ: ビルドを前提とするので CI 時間が増える（build ジョブに相乗りさせて追加コストを抑える）。
- トレードオフ: vitest の設定ファイルが3本になる。`.adr/001` が畳んだばかりの分割が別の軸で1本増える形なので、理由（プールではなくレイヤーの違い）をコメントに残す。

---

## ADR-006: wrangler 設定を request / state の2系統へ分け、DO は `exports` で宣言する

### Status

Proposed

### Context

Issue 本文の対応項目8 と受け入れ条件は「SQLite class 定義（`new_sqlite_classes` migration）」と書いているが、第9.1節が採るのは宣言的 `exports` であり、`[[migrations]]` 配列とは**排他**である（第2.1節 F-21。両方を含む設定は検証で拒否される）。加えて Worker が request / state の2本になるので、1ファイル + `[env.*]` という現行の形（sibling Worker を named environment で表す形）は使えない — `.wrangler/deploy/config.json` の redirect が全 env に効き、`wrangler deploy --env X --dry-run` が `[env.X]` の `main` を無視することが #40 の §5 で実測されているためである。

### Decision

- **`.tpl` を2系統4ファイルにする** — `wrangler.request.staging.toml.tpl` / `wrangler.state.staging.toml.tpl` / `wrangler.request.production.toml.tpl` / `wrangler.state.production.toml.tpl`。出力は `wrangler.request.<stage>.toml` / `wrangler.state.<stage>.toml`（`.gitignore` は既に `wrangler.*.staging.toml` / `wrangler.*.production.toml` を無視しているので追加不要）。
- **ローカル開発用も `apps/web/wrangler.toml`（request）と `apps/web/wrangler.state.toml`（state）の2本にする。** `@cloudflare/vite-plugin` が自動発見するのは前者だけなので、後者は `wrangler dev -c wrangler.state.toml` で別に上げる。
- **DO クラスは `exports` で宣言する。`[[migrations]]` / `new_sqlite_classes` は書かない。**
- **`main` はビルド成果物を指す**（request は `dist/server/index.js`、state は `dist/state/index.js`）。redirect が効かない経路（`wrangler deploy --dry-run`、`.tpl` からレンダリングした設定の直接利用）で設定単体が成立するようにするためである。
- **named environment（`[env.*]`）を使わない。** #40 §5 の踏み方（redirect が全 env に効く）を構造的に避ける。
- Issue 本文の当該2行は誤りなので、実装時に PR 本文で訂正を明示する。

### Consequences

- 良い点: `wrangler deploy -c wrangler.state.<stage>.toml --dry-run` が単体で成立し、#24 のデプロイ事前検知に載せられる。
- 良い点: `exports` は生成される namespace が常に SQLite backend なので、backend の取り違えが起きない。
- トレードオフ: **`exports` をデプロイした後に `[[migrations]]` 配列へ戻せない**（F-21）。fog はまだ本番 DO namespace を持たないので直行できる。
- トレードオフ: 設定ファイルが増える（ローカル2 + `.tpl` 4）。`render-wrangler.ts` を stage × role の2次元へ拡張する。

---

## ADR-007: `MailSender` は Service Binding 越しの薄いアダプターとし、未バインド時は Noop へ倒す

### Status

Proposed

### Context

`send-mail` は12種で唯一外部 I/O を伴うジョブであり、H-4 が「enqueue → 実行 → 完了」の E2E を1本要求している。ところがメール送信プロバイダは選定されておらず、第3.2節も「メール送信プロバイダのバインディング」としか書いていない（秘密ではないので `StateSecrets` にも入らない）。プロバイダ選定と運用値は #38 の範囲である。

### Decision

- **ドメイン側のポート `MailSender`（`spec/domains/identity.md` の定義。`sendPasswordResetMail(to, resetToken): Promise<void>`）を実装する。**
- **アダプターは `packages/core/src/adapters/cloudflare/mailSender.ts` に2実装を置く** — `createBindingMailSender(fetcher, appUrl, logger)`（`MAIL_SENDER` Service Binding へ `POST` する。`providerIdempotencyKey` を `Idempotency-Key` ヘッダで運ぶ）と `NoopMailSender`（バインディング未設定時。`logger.warn` して成功を返す）。
- **state Worker の合成ルートは `env.MAIL_SENDER` の有無で選ぶ。** ローカル / 統合テストでは未設定なので Noop になり、E2E は「ジョブ行が `done` に落ちること」と「`MailSender` が期待どおりの引数で1回だけ呼ばれること」（フェイク注入）で検証する。
- プロバイダの選定・URL・リトライ方針・空振り行の保持期間の運用値は #38 へ送る。

### Consequences

- 良い点: 外部依存を持ち込まずに H-4 の E2E が書ける。ジョブ機構の at-least-once・冪等キー・backoff・poison がすべて検証対象に入る。
- トレードオフ: 本番でメールが実際に届くことは #38 のプロバイダ配線まで検証されない。`NoopMailSender` が本番で選ばれると黙ってメールが消えるので、**state Worker の合成ルートは `MAIL_SENDER` 未設定を `logger.warn` で毎回報告する**。

---

## ADR-008: `SearchIndexPort.query` は #37 では実装せず、projection の検証に必要な読みだけを置く

### Status

Proposed

### Context

Issue 本文が「検索 usecase と検索ページの実装は #10 の担当。本 Issue はその土台となる DO 内 FTS5 schema と同期 projection まで」と明記している。一方、対応項目4 は tokenizer を**実環境で検証**することを要求し、その検証には FTS5 への問い合わせが要る。`.adr/006` が定めるカーソル方式のスナップショット（物理形は #37 が決めると `spec/database/index.md` が書いている）まで実装すると #10 と重複する。

### Decision

- **`SearchIndexPort` の実装は #37 では作らない。**
- **代わりに `packages/core/src/adapters/cloudflare/search/probe.ts` に、tokenizer 検証専用の最小の読み関数を置く** — `matchFts(sql, keyword, limit)`（`search_fts MATCH ?` + `bm25(search_fts, 3.0, 1.0)` 順）と `matchShortKeyword(sql, keyword, limit)`（`instr(title, ?) > 0 OR instr(body, ?) > 0`）の2本。DTO は `search_entries.id` / `type` / `timestamp` だけを返す。
- **不透明カーソルのスナップショットの物理形は #37 では決めない。** `spec/database/index.md`「本ファイルで定義しないテーブル」の当該行に「#10 へ委譲」を追記し、#10 の Issue へコメントする。
- `probe.ts` は #10 が `SearchIndexPort` を実装するときに吸収するか削除する旨を JSDoc に書く。

### Consequences

- 良い点: tokenizer の実環境検証（AC）が満たせて、かつ #10 と重複しない。
- トレードオフ: 「実装されているのに usecase から使われない関数」が1ファイル残る。用途と行き先を JSDoc に明記する。
- トレードオフ: カーソル方式の物理形が未決のまま #10 へ渡る。`spec/database/index.md` の該当行の主体を #37 → #10 へ書き換えるので、宙に浮かない。

---

## ADR-009: `drizzle-orm` / `drizzle-kit` を依存から外し、DO では素の `SqlStorage` を使う

### Status

Proposed

### Context

D1 アダプターは drizzle のクエリビルダと `db.batch()` に依存していた。DO の `ctx.storage.sql` は `exec(query, ...bindings)` を返す `SqlStorage` であり、drizzle の SQLite ドライバに DO 用のものは無い。FTS5 の特殊コマンド構文（`INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', …)`）や `RETURNING 1` による OCC 判定も、クエリビルダを通すより素の SQL のほうが `spec/database/index.md` と1対1に読める。

### Decision

- **`@repo/core` の dependencies から `drizzle-orm` を、`@repo/web` の devDependencies から `drizzle-kit` / `drizzle-orm` を外す。** `apps/web/drizzle.config.ts` を削除する。
- **DDL とクエリは素の SQL 文字列として書き、`packages/core/src/adapters/cloudflare/sql/exec.ts` の薄いラッパ経由で発行する。** ラッパが担うのは (i) `SqlStorageCursor` から行配列 / 単一行 / 行有無を取り出す、(ii) bind パラメータが100を超える呼び出しを開発時に検出する、(iii) `SQLITE_FULL` / `SQLITE_CONSTRAINT*` を共有エラー契約へ翻訳する、の3つだけである。
- **スキーマの正本は `spec/database/index.md`**、コード側の正本は `adapters/cloudflare/schema/*.ts` の DDL 文字列である。生成ツールは使わない（forward-only の migration ステップ配列が正本なので、スナップショット差分から生成する形と噛み合わない）。

### Consequences

- 良い点: 依存が2つ減り、`spec/database/index.md` の DDL とコードが逐語で突き合わせられる。
- 良い点: FTS5 の `'delete'` コマンド構文のように、クエリビルダで表現できない文が自然に書ける。
- トレードオフ: 型付きのクエリビルダが無くなるので、列名のタイポが実行時まで出ない。**DDL と同じファイルで列名を `const` として宣言し、クエリ側がそれを参照する形にはしない**（SQL 文字列がテンプレートリテラルの継ぎ接ぎになって読めなくなるため）。代わりに、各テーブルの全列を1回ずつ読み書きする統合テストを DDL と対で置く。

---

## ADR-010: 移行期の既存 D1 データは移行しない

### Status

Proposed（第11.2節「既存 D1 データのカットオーバー方針」の再確認）

### Context

第11.2節が「移行しない。DO 側で作り直す。実装済みドメインは `identity/User` だけで、本番稼働しているサービスが無いため」と決めている。一方 Pulumi の D1 リソースには `{ protect: true }`（"D1 is the system of record — refuse accidental destroy"）が掛かっている。

### Decision

- **移行ツールを作らない。**
- **Pulumi から D1 / Queue リソースを削除する。`protect: true` の解除は `pulumi state unprotect` を実行する運用手順であり、コードからは `protect` の指定ごと消す。** 手順そのものは #38 の運用ドキュメントに送る（PR 本文にも1行残す）。
- 実測として `Pulumi.{staging,production}.yaml` は `REPLACE_WITH_CF_ACCOUNT_ID` のままで、どのスタックも `up` されていない。したがって解除手順は将来のために書き残すだけで、#37 の作業では実行されない。

### Consequences

- 良い点: 移行ツールの実装・検証コストがゼロになる。
- トレードオフ: 既に D1 を `up` した環境があれば手動の解除が要る。PR 本文と #38 へ引き継ぐ。

---

## ADR-011: DO namespace を Pulumi で provision しない

### Status

Proposed

### Context

`.thread/34/design.md` 第11.2節の変更対象一覧は `infra/cloudflare/pulumi/resources/index.ts` について「D1 リソースと events / DLQ Queue リソースを削除し、**DO namespace のレンダリングを足す**」と書いている。ところが同じ文書の第9.1節は DO class の lifecycle を**宣言的 `exports`** で管理すると決めており、`exports` は wrangler が deploy 時に namespace を作る仕組みである（`[[migrations]]` 配列とは排他。第2.1節 F-21）。両方をやると、Pulumi が作った namespace と `exports` が作る namespace のどちらが権威かが二重になる。

現行の Pulumi はそもそも Worker を1つも provision していない（`WorkerScript` が無く、全 Worker が `wrangler deploy` でデプロイされる）。namespace は Worker の script に紐づくので、Worker を Pulumi の管轄外に置いたまま namespace だけを Pulumi に持たせる形は成立しない。

### Decision

- **Pulumi では DO namespace を provision しない。** `resources` スタックに残すのは `Zone` と `exportedAppUrl` / `exportedAppHostname` / `exportedPrefix` / `zoneId` だけである。
- **DO class の宣言は state Worker の wrangler 設定の `exports` が唯一の権威**である（adr.md ADR-006）。
- 第11.2節の当該行は「`exports` を採る」という第9.1節の結論より前に書かれた記述として扱い、**第9.1節を優先する**。

### Consequences

- 良い点: namespace の権威が1箇所（state Worker の設定）に閉じる。ストレージ種別（`sqlite`）の取り違えも起きない。
- トレードオフ: Pulumi のスタック出力から DO に関する情報が得られないので、`render-wrangler.ts` の substitution map に DO 由来のプレースホルダを置けない。DO binding は `.tpl` に固定文字列（class 名と `script_name = "${RESOURCE_PREFIX}-state"`）として書く。
- トレードオフ: `exports` 経由で削除した namespace に Trash が無い（F-21）ので、削除は Pulumi の destroy 保護のような仕組みで守れない。**tombstone をデプロイする前にデータを退避する**運用手順を #38 へ送る。

---

## ADR-012: `credential_mappings` の書き込みは `CredentialMappingStore` として UoW コンテキストに載せる

### Status

Proposed

### Context

`spec/domains/identity.md` は Identity Directory 側の書き込み操作（reserve / activate / cancel / begin / promote / delete / reportResult）について「**これらは `CredentialMappingRepository` のメソッドではない。** 手続きの各段が認証情報側へ発行する操作であり…**実装形は `spec/database/index.md` と #37 が決める**」と明記しており、この決定は #37 の責務として残されている。

ところが ADR-003 の `IdentityDirectoryUnitOfWorkContext` は `credentialMappingRepository`（**読み3本だけ**）/ `resetTokenStore` / `rotationCheckpointStore` / `enqueueJob` で、書き込み口を1つも持たない。一方で第5.1節の `reserve-credential` は「**同じ `transactionSync` で `sweep-reservations` と（コーディネーターなら）`resume-signup` を投入**」を要求する。`enqueueJob` はコンテキスト経由でしか届かないので、書き込み口が無いまま実装すると次のどちらかに落ちる。

- (a) `uow.run(ctx => ...)` の中から生の `sql` を掴む — コンテキストに `sql` を載せることになり、第8.2節が明示的に禁じた「`ctx.storage.sql` を usecase から直接触る形」になる。
- (b) facade が自分で `ctx.storage.transactionSync(...)` を開く — **Identity Directory DO には UoW を通る書き込み経路が1本も無くなり**、`IdentityDirectoryUnitOfWorkContext` が事実上デッドコードになる。`CLAUDE.md` の「every transactional usecase runs inside `UnitOfWorkProvider.run(fn)`」が片方の DO クラスで成立しなくなる。

### Decision

- **ドメイン側に書き込み専用ポート `CredentialMappingStore` を新設する**（`packages/core/src/domain/identity/ports/credentialMappingStore.ts`）。メソッドは `reserve` / `activate` / `cancel` / `beginChange` / `promote` / `delete` / `reportResult` の7本で、すべて `operationId` / `payloadDigest` / `status` / `change_state` を条件に含む CAS。`ExpectedVersion` を取らない（`credential_mappings` は OCC の `version` を持たない。`spec/database/index.md`:619）。
- **読み取りポート `CredentialMappingRepository`（読み3本）はそのまま残す。** 読みと書きを別ポートに分けるのは、ドメイン側が「これらはリポジトリのメソッドではない」と明言していることに従った形である。
- **`IdentityDirectoryUnitOfWorkContext` に `credentialMappingStore` を載せる。** これで Directory 側のトランザクション内書き込み口は `credentialMappingStore` / `resetTokenStore` / `rotationCheckpointStore` / `enqueueJob` の4つになり、**その全数が型に現れる。** facade は `sql` を掴まない。
- 実装は `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`（`createCredentialMappingStore(sql, now)`）。facade はこのモジュールを直接 import せず、`identityDirectory/unitOfWork.ts` が組んだコンテキスト経由でだけ触る。

### Consequences

- 良い点: 「予約行の書き込み + `enqueueJob` を同一 `transactionSync`」が UoW コンテキストだけで合成でき、第5.1節の要求と `CLAUDE.md` の UoW 規約が両立する。
- 良い点: **`spec/database/index.md` の「非集約ストアへの書き込み口は6ストア・7メソッド」という全数は崩れない。** 同ファイルの分類表（:749-:750）が `credential_mappings` を「非集約ストア7つ」ではなく「**CAS で直列化**」という独立した区分に置いているためで、7ストアの外に口を1本増やす形になる。突き合わせ規則としては「非集約ストア6ストア・7メソッド + CAS 区分の `credentialMappingStore` 7メソッド」と書く。
- トレードオフ: identity のポートが1本増える（7本 → 8本）。`.adr/008` が「ポート本数は増えるが、上位の層が使う名前がすべてドメイン側にアンカーを持つ」と受け入れた方向と同じである。
- トレードオフ: 読みと書きが別ポートに割れるので、同じ行を読んでから書く箇所は2つのポートを触る。CAS 条件が権威なので「読んで判断して書く」がリクエストを跨がない（`spec/database/index.md`:619）以上、問題にならない。

---

## ADR-013: `.thread/34/design.md` 第11.2節の6項目のうち、credential 変更経路に属する2項目は #12 へ送る

### Status

Proposed

### Context

`.thread/34/design.md` 第11.2節は「本設計が新しく導入した『テーブル定義の外の作業』のうち…**#37 が拾い落とさないように名指ししておく**」として6項目を挙げている。steps.md 冒頭の正本優先順位（`spec/…` > `spec/domains/` > `.thread/34/design.md` > `.adr/` > 本計画）では design.md が本計画より上位なので、**落とすなら記録が要る**（無記録だと「読み落とした」のか「意図して落とした」のかが後から区別できない）。

6項目のうち #37 の他の判断（`plan.md` のスコープ「パスワード変更 / リセット完了は #12」）と衝突するのは次の2つである。

1. **`report-verify-result`** — パスワード変更 phase 0 の A-4（`report-login-result` と同型）。同項は「**あわせて** `lookup-credential-by-locator` に `nextAttemptAllowedAt` 未到達の**拒否**（ダミー化ではない）と、`callerToken` 照合を先に評価する順序を実装する」とも書いている。どちらもパスワード変更経路に属する。
2. **`credential_mappings.changeState` の3値化のうち behavioral な半分** — 「`promote-verifier` は `'advanced'` だけを通す」というガード。`promote-verifier` は credential 変更 saga の phase 3 のエントリである。

### Decision

- **上の2項目は #12（SSO・パスワード変更・パスワードリセットの完了）へ送る。** `report-verify-result` / `lookup-credential-by-locator` / `promote-verifier` は steps.md ステップ16 の「実装しないエントリ」に担当 Issue 付きで残し、JSDoc の全数表からも落とさない。
- **`changeState` の3値化のうち DDL 側（CHECK 制約が `null` / `'pending'` / `'advanced'` の3値であること）は #37 で実装する。** これは `plan.md` の AC-27 (iv) であり、#45 が「phase 2 が適用済みか」を判定する唯一の材料なので落とせない。**落とすのは値を読むガードの側だけ**である。
- 残る4項目（`list-bucket-user-ids` / `read-schema-version` をゲート・fail-closed・arming から外す / 分類 (C) の一様な終端 / リセットトークン発行時の未使用行削除 / phase 4 の原子性）は **#37 で実装する**。
- **この内訳を `plan.md` のスコープ「含まれないもの」に明記する。**

### Consequences

- 良い点: design.md 第11.2節の索引に対して、#37 の側の応答が6項目すべてについて残る（4実装 / 2委譲）。#12 が拾う材料も明示される。
- トレードオフ: `lookup-credential-by-locator` は #37 が実装する `lookup-credential` と近い形なので、#12 が書くときに一部を再発見する。ステップ16 の JSDoc 全数表に担当 Issue と参照節（第6.2.2節 (a)・第6.5.1節）を書いて緩和する。
- トレードオフ: `promote-verifier` のガードが無い状態で `changeState = 'advanced'` の行が作られる経路も #37 には無い（`begin-credential-change` / `advance-credential-change` がどちらも未実装）ので、**中途半端に片方だけ動く状態は生まれない。** 3値の CHECK だけが先に入る。

---

## ADR-014: RPC 値エンベロープの型は `packages/core/src/lib/rpcEnvelope.ts` に置く

### Status

Proposed

### Context

`ARCH-P-004`（1周目）は「`platform/envelope.ts` が presentation の `SerializedError` union を型に取ると依存が逆流する」という指摘で、その反映として型引数を `SerializedErrorBase & { kind: string }` に絞り、`kind` → 例外クラスの復元を `packages/core/src/application/rpc/restoreError.ts` へ置くと決めた。

**presentation 方向の逆流は断てたが、別方向の逆流が新しく生まれた。** `restoreError.ts`（application 層）は `RpcEnvelope<T>` / `SerializedErrorPayload` を引数と戻り値の型に使うので、それらが `packages/core/src/adapters/cloudflare/platform/envelope.ts` にある限り **`application → adapters` を import せざるを得ない**。これは `plan.md` のリスク欄が挙げている逆流 (b)（`application/di/secrets.ts` → `adapters/webcrypto/hmacSessionCodec`）と**同じ形**であり、#37 はそれを `packages/core/src/lib/secretLengths.ts` へ移して断つと決めている。加えて **AC-25 が「`adapters/` ↔ `application/` の逆流 import が0件」を機械検証の条件として名指ししている**ので、このままだと計画が自分の AC を満たせない。ステップ4 に置いた `grep -rn "presentation" packages/core/src` は presentation 方向しか見ないため、この逆流を検出しない。

### Decision

- **値エンベロープの「型」を `packages/core/src/lib/rpcEnvelope.ts`（新規）へ置く。** 中身は `RPC_ENVELOPE_VERSION` / `SerializedErrorPayload` / `RpcEnvelope<T>` の3つで、import は同じ `lib/` の `SerializedErrorBase` を type-import する1本だけである。
- **`adapters/cloudflare/platform/envelope.ts` に残すのは `toSerialized()` を叩く構築ヘルパ `ok` / `err` の2本だけ**にする。型を re-export もしない（re-export すると同じ逆流が名前だけ変えて復活する）。
- **`application/rpc/restoreError.ts` は `lib/rpcEnvelope.ts` から型を取る。** これで `restoreError.ts`（application）→ `lib/`、`envelope.ts`（adapters）→ `lib/` の**両方が内向き**になる。
- **AC-25 の機械検証を2本立てにする** — (i) presentation を import していないこと、(ii) `application` → `adapters` の逆流 import が無いこと。**この2本の具体形（import 文だけを見る正規表現・`di/` と `__tests__/` の除外・その根拠）は ADR-018 で確定させた。** 本 ADR がここに書いていた語ベースの grep 2本は、実測でどちらも 0 件にならず**そのままでは実行できない**（散文の `presentation` 9件 / テストハーネスの `adapters/` 逆流 9件）ので、**ADR-018 の形に読み替える。**

### Consequences

- 良い点: `CLAUDE.md`「Not a layer」が `lib/` を「全層が依存してよい構造的プリミティブ」と定義し、`SerializedErrorBase` が既にそこにある以上、**値エンベロープはその定義にそのまま当てはまる**。置き場の根拠が規約側に既にある。
- 良い点: 逆流の検出が grep 1本から2本になり、**presentation 方向だけを見ていた盲点が閉じる。** 同じ盲点で見落とされた指摘が実際に1件あった以上、検査を足す価値がある。
- トレードオフ: `packages/core/src/lib/` のファイルが増える（`error.ts` / `jobKind.ts` / `jobBudgets.ts` / `passwordHashing.ts` / `secretLengths.ts` / `rpcEnvelope.ts` の6本）。いずれも「複数レイヤーが共有する構造的プリミティブ」という同じ基準で置かれているので、基準がぶれてはいない。
- トレードオフ: エンベロープの型と構築ヘルパが別ファイルに割れる。`envelope.ts` の JSDoc に「型は `lib/rpcEnvelope.ts`。ここに置かない理由は ADR-014」を1行書いて迷子を防ぐ。

---

## ADR-015: DO 統合テストのテスト間クリーンアップは `reset()` と `evictAllDurableObjects()` の明示呼び出しで行う

### Status

Proposed（`ARCH-S-010`（1周目）の結論「`isolatedStorage` の既定に乗る」を破棄して置き換える）

### Context

1周目の `ARCH-S-010` は「`@cloudflare/vitest-pool-workers` は既定でテストごとにストレージをロールバックするので明示クリアを置かない。ただしインスタンス状態（`AlarmCache`）は戻らないので `beforeEach` で `resetAlarmCache()` を呼ぶ」と決着させた。

**この結論は現行版に存在しない機能を前提にしていた。** 実測で、解決版 `@cloudflare/vitest-pool-workers@0.16.20`（root / `apps/web` とも specifier は `^0.16.4`）のパッケージ全体を grep して `isolatedStorage` は **0 件**（sourcemap 込み）であり、`dist/pool/index.d.mts:9-73` の `WorkersPoolOptionsSchema` のトップレベルは `main` / `remoteBindings` / `additionalExports` / `miniflare` / `wrangler` の**5つだけ**で、ストレージのスタック機構（`pushStorage` / `popStorage` 相当）も残っていない。**したがって「既定に乗る」は成立せず、そのまま実装すると DO の SQLite 状態がテスト間で持ち越され、ステップ8〜10 / 20〜22 のテストが順序依存で不安定になる。**

代わりに `cloudflare:test` が明示 API を export している（`types/cloudflare-test.d.ts`。実測）。

- `reset(): Promise<void>` — 「Deletes all data from all attached bindings.」。JSDoc の用例そのものが `afterEach` である。**自動では呼ばれない。**
- `evictAllDurableObjects(options?): Promise<void>` — durable storage を保ったままインスタンスを破棄して**インメモリ状態をリセット**する。graceful（in-flight の完了を待つ）。
- `abortAllDurableObjects(): Promise<void>` — 同じことを非 graceful に行う版。

### Decision

- **`packages/core/src/adapters/cloudflare/__tests__/setup.ts` の `afterEach` で `reset()` → `evictAllDurableObjects()` の順に呼ぶ。** 順序はデータを消してからインスタンスを畳む向きに固定する。
- **`AlarmCache` の初期化は `evictAllDurableObjects()` で行う。** `listDurableObjectIds` + `runInDurableObject` で `resetAlarmCache()` を呼ぶ形は採らない。
- **プロダクションの DO クラスにテスト専用の public メソッド（`resetAlarmCache()` 等）を生やさない。** これが本 ADR の実質的な利得である。
- `abortAllDurableObjects()` は採らない（in-flight を待たないので、落ちたときに原因がテストなのかレースなのか切り分けられない）。
- **「なぜ2本とも要るのか」を setup 冒頭のコメントに書く**（射程が違う — 片方はストレージ、もう片方はインメモリ状態）。`.adr/001` の「理由を説明できない設定を残さない」と同じ論法である。

### Consequences

- 良い点: **`ARCH-S-010` が正しく指摘していた非対称（ストレージとインスタンス状態は別物）は結論として残る。** 変わったのは「ストレージ側が自動か手動か」だけで、非対称そのものの認識は維持される。
- 良い点: DO クラスの public API がプロダクションの必要だけで決まる。テスト都合のメソッドが `#37` の全数表（ステップ16 の RPC エントリ表）に混じらない。
- トレードオフ: `afterEach` が2本になるぶんテストの実行時間が延びる。`reset()` は「全バインディングのデータ削除」なので、スイートが育つと効いてくる。**計測して問題になったら `evictAllDurableObjects()` だけをテストファイル単位へ落とす**（`AlarmCache` を触らないテストではストレージのリセットだけで足りる）。#37 では単純さを採る。
- トレードオフ: pool-workers の版が上がって自動ロールバックが復活すると、この明示クリアは冗長になる。**版に依存した判断であることを setup のコメントに残す**（`@cloudflare/vitest-pool-workers@0.16.20` で確認した旨と日付）。

---

## ADR-016: canonical 化と HMAC 導出は request Worker、Directory DO は `(kind, hmac)` で引く

### Status

Proposed

### Context

Issue の受け入れ条件3 と `plan.md` の AC-2 は「正規化メール / **SSO provider + subject** から `userId` を解決できる」を要求する。ところが `spec/domains/identity.md` のポート定義は次の形である。

```ts
findByEmail(email: Email): CredentialMapping | null;
findBySsoIdentity(provider: SsoProvider, providerSubject: string): CredentialMapping | null;
```

**この署名のまま Identity Directory DO の中で実装することは原理的にできない。** mapping 行のキーは `(kind, 全長 hmac)` であり（`spec/database/index.md`）、HMAC の材料である `DIRECTORY_ROUTING_SECRET` は **request Worker にしか配らない**（`.thread/34/design.md` 第5.2.3節。#37 の `StateEnv` にも入っていない）。ポート署名を字面どおりに読むと、実装者はここで止まるか、**state Worker へ routing secret を配る**という誤りに倒れる。後者は「配布は非重複である」という第5.2節の決定を壊し、AC-3 に正面から反する。

加えて、SSO canonical の規則（`provider` を lowercase 化し `provider + U+0000 + subject` を canonical とする。第5.2.1節 (c)）を**組み立てるコードが、1周目までの計画のどのステップにも存在しなかった**。`Email.create` は canonical 化を持つが、SSO 側には対応する関数が無く、`directoryLocator.forCanonical(canonical: string)` は canonical を引数として受け取る側である。結果として AC-2 の SSO 半分は実施も検証もされないまま緑になりうる状態だった。

### Decision

- **責務を境界で切る。** canonical 化（`Email.create` / `ssoCanonical`）と canonical → HMAC → locator の導出（`directoryLocator.forCanonical`）は **request Worker** の責務、`(kind, hmac)` での行の引き当ては **Directory DO** の責務とする。**state Worker に `DIRECTORY_ROUTING_SECRET` を配らない。**
- **`packages/core/src/domain/identity/valueObject.ts` に `ssoCanonical(provider: SsoProvider, providerSubject: string): string` を足す。** `provider.toLowerCase()` + 区切り子 + `providerSubject.trim()`。**subject には NFKC も lowercase も掛けない**（provider 由来の opaque 値）。**区切り子はソースにエスケープ表記で書き、生の NUL バイトを埋めない**（埋めると `grep` がバイナリ扱いして機械検証が無言で壊れる。第5.2.1節 (c)）。
- **DO 内の実装署名を読み替える。** `findByEmail` / `findBySsoIdentity` は**ドメインから見た契約**であり、`packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts` の実装は `(kind: "email" | "sso", hmac: string)` を取る1本（`findByLocatorKey`）にまとめる。`email` / `sso` の名前の区別は、canonical を組み立てる request Worker 側にある。**この読み替えを実装ファイルの JSDoc に明記する。**
- **`lookupCredential` の引数は `(kind, hmac, …)` であり、`kind='sso'` を受ける。** `kind='sso'` の行は `passwordVerifier` を持たないので均一化すべき計算量が無く、返るのは `userId` / `credentialId` / `credentialVersion` / `usedLocator` である（第5.3節「SSO login」3）。
- **#37 が実装するのは「既存の SSO クレデンシャルから `userId` を解決する読み経路」だけである。** OIDC フロー・`registerOrLoginWithSso`・link / unlink は #12。`kind='sso'` の行を**書く**経路は #37 に無いので、統合テストは行を直接投入して読み経路だけを固定する。

### Consequences

- 良い点: 受け入れ条件3 の SSO 半分が、実装点（`ssoCanonical` + `lookupCredential` の `kind` 対応）と検証点（ステップ21 の4ケース）を両方持つ。
- 良い点: 「ポート署名どおりに実装できない」という行き止まりが、**誤った方向（routing secret の再配布）へ倒れる前に**計画側で解決される。
- トレードオフ: `spec/domains/identity.md` のポート署名と実装署名が一致しない。**ドメイン側の署名は変えない** — 契約が「メールで引ける / SSO 主体で引ける」であること自体は正しく、変えるべきは実装の置き場ではなく読み方だからである。齟齬は JSDoc 1行で吸収する。
- トレードオフ: `kind='sso'` の行を書く経路が無いまま読み経路だけが存在する。#12 が書き経路を足すときに、この読みが既に固定されていることが制約になる（それが意図である）。

---

## ADR-017: state Worker のビルドは独立した vite 設定に分け、`build:cf` を2段にする

### Status

Proposed

### Context

state Worker（`apps/web/app/worker/cloudflare/state.ts`）の成果物 `dist/state/index.js` を最初に要求するのは**起動スモークテスト**（steps.md ステップ24。`miniflare` の `workers: [{ name: "state", scriptPath: "apps/web/dist/state/index.js" }]`）である。ところが 1周目までの計画では、そのビルド設定（`apps/web/vite.config.state.ts`）を**ステップ25**（wrangler 設定）に置いていた。**ステップ24 がステップ25 の成果物に依存する順序逆転**である。

さらに、`dist/state/index.js` を実際に作るには **`build:cf` スクリプト自体**を「request ビルド + state ビルド」の2段へ変える必要があるが、実測で現行は `apps/web/package.json` の `build:cf = "vite build --config vite.config.cloudflare.ts"` の1段だけであり、**この変更はどのステップの対象ファイルにも入っていなかった**（ステップ25 の対象に `package.json` が無く、ステップ26 の変更内容は `db:*` / `deploy:*` / `test:smoke` / `dev:state` に限られる）。ステップ25 とステップ32 の検証欄は「`pnpm build:cf` の後に `dist/state/index.js` が存在する」を前提にしている。

ステップ25 には「`@cloudflare/vite-plugin` の multi-worker サポートで1設定に収まるかを着手時に確認し、収まらなければ設定を分ける」という**未確定の分岐**も残っていた。

### Decision

- **`apps/web/vite.config.state.ts` を独立した設定として置き、`state.ts` を `build.lib` で `dist/state/index.js`（ESM・単一ファイル）へ出す。** 「1設定に収まるかを確認する」という分岐は**残さない** — TanStack Start のプラグイン鎖は request Worker のためのものであり、公開ルートを持たない state Worker（`export default { fetch: () => 404 }` と DO クラス2本の re-export だけ）に掛ける理由が1つも無い。分岐を残すと、ステップ24 が依存する成果物の作られ方が着手時まで確定しない。
- **`apps/web/package.json` の `build:cf` を2段にする** — `vite build --config vite.config.cloudflare.ts && vite build --config vite.config.state.ts`。`outDir` が別なので `emptyOutDir` の既定で相互に消し合わないことを確認する。
- **この作業の所有ステップは6（DO クラスの骨格と state Worker エントリ）である。** 「state Worker のエントリを作ったステップが、その成果物の作り方も持つ」形にすれば順序逆転が起きない。**ステップ25 が扱うのは wrangler 設定側だけになり、`vite.config.*` には触らない。**
- ステップ6 の検証に「`pnpm build:cf` の後に `dist/server/index.js` と `dist/state/index.js` の両方が存在する」を足す。

### Consequences

- 良い点: ステップ24 / 25 / 32 の「`dist/state/index.js` が存在する」という前提が、それを作るステップより後に来る。順序が手順として閉じる。
- 良い点: `build:cf` の書き換えが無担当のまま残らない。実測で 1周目までの計画にはこの変更を持つステップが1つも無く、実装時に落ちる筋のものだった。
- トレードオフ: vite の設定ファイルが1本増えて3本になる（`vite.config.ts` / `vite.config.cloudflare.ts` / `vite.config.state.ts`）。**vitest の設定3本（`.adr/001` + ADR-005）と合わせると設定ファイルが増えるので、それぞれの冒頭に「何のための設定か」を1行書く。**
- トレードオフ: CI のビルド時間が state Worker のぶん増える。バンドル対象は DO クラス2本と `@repo/core` の DO 側だけなので、request Worker のビルドに比べれば小さい。

---

## ADR-018: 層間逆流の機械検証は「import 文だけを見る」形に確定し、合成ルートとテストハーネスを除外する

### Status

Proposed

### Context

ADR-014 は「逆流の検出が grep 1本から2本になり、presentation 方向だけを見ていた盲点が閉じる」と書いて、AC-25 の機械検証を2本立てにした。**ところが、その2本は実測でどちらも 0 件にならない。** 置かれたステップ4 でも、最終ゲート（steps.md ステップ32 項目11）でも成立しない。

- **(i) `grep -rn "presentation" packages/core/src`** — 実測で **9件**ヒットするが、**すべて import ではなく JSDoc の散文**である（`application/types.ts:8` / `di/types.ts:33,49` / `errors.ts:82,129,132` / `ports/sessionCodec.ts:5,10` / `ports/outboxRepository.ts:3`）。#37 で消えるのは `ports/outboxRepository.ts` の1件だけで、**残る8件は層の役割を正しく説明している記述であり、消す理由が無い。** とくに `errors.ts:129` の「These live in the application layer (not presentation) because the … is a pure transport concern owned by the presentation layer.」は、AC-25 が守りたい規約そのものの説明である。このまま実装すると、実装者は「正しいコメントを消して grep を通す」か「AC を無視する」の二択になる。
- **(ii) `grep -rn "adapters/" packages/core/src/application --include='*.ts' | grep -v '/di/'`** — 実測で **9件**ヒットし、内訳は `application/__tests__/helpers.ts`（6件）/ `application/identity/__tests__/identity.integration.test.ts`（2件）/ `application/workers/__tests__/eventRelayWorker.integration.test.ts`（1件）である。ステップ4 の時点で通らないのは当然として（削除はステップ12 / 19 / 21）、**ステップ19 で `application/__tests__/helpers.ts` を DO ハーネスへ作り直す以上、最終状態でも 0 件にならない** — ハーネスの目的が具象アダプターの組み立てなので、`adapters/cloudflare/…` を value import する以外に書きようがない（現行も `adapters/webcrypto/hmacSessionCodec` を import している）。

これは `COV-P-007`（1周目）が `tanstack-start-template` の grep について確立した「**落ちない形に確定してから AC に書く**」という原則が、2周目で新設した検査には適用されなかったという形である。AC-25 は「機械検証」を名乗っている以上、通らない形のまま残すと最終ゲートで判断が止まる。

### Decision

- **2本とも「import 文だけを見る」形に確定する。** 語としての出現ではなく、`from "…"` / `require("…")` の**モジュール指定子**を検査対象にする。
  ```sh
  # (i) presentation を import していない（散文の言及は対象外）
  grep -rnE "from \"[^\"]*presentation|require\(\"[^\"]*presentation" packages/core/src
  # (ii) application → adapters の逆流（合成ルート di/ とテストハーネス __tests__/ を除く）
  grep -rnE "from \"(@repo/core/adapters/|\.\./+adapters/)" packages/core/src/application \
    --include='*.ts' | grep -v '/di/' | grep -v '/__tests__/'
  ```
- **(ii) の除外を `di/` と `__tests__/` の2つにし、それぞれの根拠を AC-25 本文と steps.md ステップ4 に明記する。** `di/`（合成ルート）は「具象アダプターを組み立てる唯一の正当な場所」、`__tests__/`（テストハーネス）は「**合成ルートと同じ役割で具象を組み立てる場所**」である。前者は `CLAUDE.md`「Dependencies point inward … adapters implementing ports defined inward of them」が根拠、後者は「ハーネスは production の依存グラフではなく、テスト対象へ実物を与えるための組み立て点である」という射程の違いが根拠である。
- **`__tests__/` の除外は「テストなら何をしてもよい」ではない。** 除外の射程は**逆流 import の検査だけ**であり、`packages/core/src/application/**/__tests__/` が具象アダプターを組み立ててよいのは、それが**テスト対象へ実物を与えるための合成**である場合に限る。プロダクションコードから `__tests__/` を import する経路は別問題として残らない（存在しない）。
- **書いた形が現行リポジトリでも 0 件になることを、AC に書く前に実測で確認する。** 上の2本は確認済みである（どちらも 0 件）。これで検査は**着手前・着手中・最終状態のどの時点でも成立**し、「今は赤だが最後には緑になるはず」という状態を持たない。

### Consequences

- 良い点: AC-25 の2本が、ステップ4 の検証欄でも最終ゲートでもそのまま実行できる。ADR-014 が意図した「盲点を閉じる」効果が初めて実効を持つ。
- 良い点: 検査が語ではなく import を見るので、**JSDoc が層の関係を正しく説明することを妨げない。** 規約の説明文を書けば書くほど機械検証が赤くなる、という逆インセンティブが消える。
- トレードオフ: 除外が2つに増え、`grep` のパイプが長くなる。除外の根拠を書かないと「都合の悪いものを外しただけ」に見えるので、**AC-25 本文・ステップ4 の検証欄・本 ADR の3箇所に同じ根拠を置く**（`COV-P-007` で `.thread/` と `spec/idea.md` の除外根拠を書いたのと同じ扱い）。
- トレードオフ: 正規表現が import の書き方（`from "…"` / `require("…")`）に依存する。実測で `packages/core/src` の側効果 import（`import "…"`）は **0件**、動的 `import()` は **2件**だがどちらも `application/identity/__tests__/loginWithPassword.test.ts` から同じ application 層のモジュール（`../loginWithPassword`）を指しており、**検査したい2方向のどちらにも当たらない。** 将来この書き方で層をまたぐなら、検査側の正規表現も足す。

---

## ADR-019: 単一行テーブルの制約は定数式の UNIQUE 索引で掛け、サロゲート列を足さない

### Status

Proposed

### Context

`spec/database/index.md` は `account` / `user_settings` / `_meta` を「単一行のテーブル」と定め、**掛け方は実装裁量とする（#37）** と明記して #37 に委ねている。同時に同ファイルの共通方針は「**節に無いサロゲートの `id` 列を足してよいという読み方はしない**」とも書いている。素直な実装（`id INTEGER PRIMARY KEY CHECK (id = 1)`）はこの2つの指示に挟まれる — 制約は掛かるが、spec の列一覧に無い列が1本増え、AC-1 / ステップ8 の「列を逐語で突き合わせる」検証がテーブル3つぶんずれる。

### Decision

- **列を足さず、常に同じ値を返す式に対する UNIQUE 索引で掛ける。**
  - `CREATE UNIQUE INDEX account_singleton_uq ON account ((status IS NOT NULL))`
  - `CREATE UNIQUE INDEX user_settings_singleton_uq ON user_settings ((trash_retention_days IS NOT NULL))`
  - `CREATE UNIQUE INDEX meta_singleton_uq ON _meta ((schema_version IS NOT NULL))`
- 式は NOT NULL 列に対する `IS NOT NULL` なので恒真であり、索引のキー空間が1値に潰れて2行目の INSERT が UNIQUE 違反になる。**SQLite / workerd 上で実測して動作を確認済み**（ステップ8 の統合テスト「keeps the single-row tables to one row」が常設で固定する）。
- 索引名は3本とも `*_singleton_uq` に揃え、ステップ8 の索引集合アサーションに載せる。

### Consequences

- 良い点: **spec の列一覧と DDL が逐語で一致したままになる。** AC-1 / AC-2 の突き合わせに例外規則が要らない。
- 良い点: `user_settings` の OCC が `WHERE version = ?` だけで条件づけられる（`id` 述語を持たない）という spec の規定と素直に噛み合う。
- トレードオフ: 索引が3本増え、`(status IS NOT NULL)` という式の意図が読んで即座には分からない。**DDL 側のモジュール JSDoc に理由を1段落残す**ことで緩和した。
- トレードオフ: 式インデックスの挙動に依存する。統合テストが常設なので、SQLite の版が上がって挙動が変わればそこで落ちる。

---

## ADR-020: `jobs` の DDL は共有モジュールに置き、2つのスキーマから参照する

### Status

Proposed

### Context

steps.md ステップ5 の対象ファイルは `schema/{types,userData,identityDirectory,gate}.ts` の4本で、`jobs` テーブルは User Data / Identity Directory の両方が持つ。`spec/database/index.md`「jobs（Identity Directory DO）」は「**User Data DO 側と同じ12列・同じインデックス・同じ規則である。job table と Alarm の実装は2クラスで共有する**」と明記している。両方のスキーマモジュールに DDL 文字列を複製すると、12列のうち1列を直し忘れた状態が型でもテストでも検出されない（列集合の統合テストは DO クラスごとに別々に走る）。

### Decision

- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts` を新設し、`JOBS_DDL: readonly string[]`（テーブル1 + 索引3）だけを export する。
- `userData.ts` / `identityDirectory.ts` は version 1 の statements 配列にこれをスプレッドで展開する。テンプレート補間は使わないので ADR-009 の「`${` を DDL に書かない」と衝突しない。
- `kind` の値域は CHECK ではなくハンドラレジストリの型拘束（`JobKindOf<D>`）が担保する。**DDL 側では DO クラス間で1文字も違わない**ので、共有できる。

### Consequences

- 良い点: 「2クラスで同じ表」という spec の断定が、複製ではなく1つの定義として実装に写る。
- トレードオフ: steps.md が挙げた4ファイルより1本多い。ステップ5 の対象ファイル一覧との差分は本 ADR が説明する。

---

## ADR-021: `_meta` の読み取り2本もゲートモジュールが持つ

### Status

Proposed

### Context

ステップ5 は「`_meta` を作るのはゲートのブートストラップだけであり、権威を1箇所に閉じる」と決めた。ところがステップ6 の診断エントリ（`read-schema-version`）と `selfLocator()` のフォールバックは、**ゲートを通さずに** `_meta` を読む必要がある（fail-closed の DO でも動かなければならないエントリなので、ゲートを通せない）。DO クラス側に `SELECT schema_version FROM _meta` を直接書くと、`_meta` に触るコードが2箇所になり、しかも片方は「テーブルがまだ無い」場合を自分で判定しなければならない。

### Decision

- `schema/gate.ts` に `readSchemaVersion(sql)` と `readSelfLocator(sql)` を追加し、どちらも `sqlite_master` で `_meta` の存在を先に確かめる（未ブートストラップの DO では 0 / `null` を返し、例外を投げない）。
- `apps/web/app/durable-objects/*.ts` はこの2本を呼ぶだけにし、`_meta` の SQL を持たない。
- `readSchemaVersion` が「一度も migrate していない DO」と「version 0 まで migrate した DO」を区別しないのは意図的である — ブートストラップが書く初期値が 0 なので、呼び手にとって両者は同じ意味になる。

### Consequences

- 良い点: `_meta` に触るモジュールが1つのままになり、ステップ5 の「権威を1箇所に閉じる」が読み側にも及ぶ。
- トレードオフ: ゲートモジュールが「適用」だけでなく「診断のための読み」も持つ。どちらも `_meta` の所有という同じ責務の範囲内なので、分割の基準はぶれていない。

---

## ADR-022: ステップ12 の対象に、イベントを主張しないドメイン / アダプターのテスト2本を足す

### Status

Proposed

### Context

steps.md ステップ12 は「単独で typecheck-clean」を分割の唯一の価値とし、`collectEvents` の全参照10ファイルを実測で洗い出して対象に入れてある。**ただし `WithEventDrafts` の側の洗い出しが漏れている。** ステップ12 はエンティティのファクトリの戻り値を `WithEventDrafts<User>` → `User` へ変えるので、**戻り値を `{ entity }` で分割代入している呼び出し側もすべて壊れる**。実測で、`collectEvents` を1度も参照しないのに壊れるファイルが2本あった。

- `packages/core/src/domain/identity/__tests__/entity.test.ts` — `const { entity, eventDrafts } = User.registerWithPassword(...)` が全域に散っており、イベント草稿を直接主張するケースも4本ある。
- `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts` — `.entity` を後置で剥がすヘルパが3箇所。

どちらも steps.md ステップ12 の削除・改修リストに無く、ステップ13 の「ドメイン層のテストを新しい形へ書き直す」に含まれると読むこともできるが、**そう読むとステップ12 単独で `pnpm typecheck` が通らなくなり、分割の唯一の価値が消える。**

### Decision

- 上の2本を**ステップ12 の対象に加える。** 変更は分割代入の解体だけに留め、`User` の形そのもの（`credentials` 集合への読み替え）はステップ13 に残す。
- `entity.test.ts` からはイベント草稿を主張する4ケース（`userRegistered` ×2 / `passwordChanged` / 平文リークのスキャン）を削除する。**対象消滅であって移植先は無い** — イベント機構そのものが消えるためである。平文リークのスキャナ（`containsString`）も同時に消える（唯一の被検査対象がイベント payload だった）。
- `changeTrashRetentionDays` の no-op ケースは、判定材料が「空の草稿配列」から「同一性（`next === user`）」だけになるので、その旨をテストのコメントに残す。

### Consequences

- 良い点: ステップ12 が実際に単独で typecheck-clean / test-clean になる（実測: unit 417 / integration 136 が緑）。
- トレードオフ: 「平文パスワードがイベント payload へ漏れない」という保証がテストから消える。**#37 の最終形にイベント payload が存在しないので対象消滅**であり、代替の検査は `terminal_reason` とログに対する禁止語配列（`adapters/cloudflare/__tests__/forbiddenValues.ts`）が引き継ぐ。

---

## ADR-023: `jobs.payload_digest` は非暗号学的ハッシュで足りる

### Status

Proposed

### Context

`spec/database/index.md` は `payload_digest` を「実行可能集合の行に同じ `operation_key` で違う payload が来たら `ConflictError`」を判定するための列と定めるが、アルゴリズムは定めていない。`crypto.subtle.digest` は**非同期**なので、`transactionSync` の中から呼べない — `enqueueJob` は UoW コンテキストの副作用登録点であり、同期でなければならない。

### Decision

- **FNV-1a 32bit の同期実装を `jobs/table.ts` に置く。** 入力は `JSON.stringify(payload)`（`nextRunAt` を含まない）。
- 用途は**取り違えの検出であって改ざんの検出ではない** — 値はサーバー側で組み立てられ、クライアントから来ない（「cross-request idempotency keys never come from the client」）。衝突の帰結も「本来 `ConflictError` になるべき再投入が通る」だけで、権限昇格にはならない。
- 暗号学的な強度が要る用途（`provider_idempotency_key`、リセットトークンのハッシュ）は**別の場所で `crypto.subtle` を使う**。両者を混同しない旨を関数の JSDoc に書く。

### Consequences

- 良い点: `enqueueJob` が同期のままでいられる。UoW コンテキストの同期契約に例外を作らない。
- トレードオフ: 32bit なので衝突確率はゼロではない。射程が「同じ `operation_key` の実行可能な行1本」に閉じているので、衝突が起きるには同じキーで違う payload が同時に生きている必要があり、実質的に起こらない。

---

## ADR-024: Directory 側の予約 CAS は `operationId` だけで判定し、`payloadDigest` を条件に含めない

### Status

Proposed

### Context

`.thread/34/design.md` 第5.1節は `reserve-credential` のガードを「一意制約 + `operationId` / `payloadDigest` の CAS」と書いている。ところが `spec/database/index.md` の `credential_mappings` の列一覧には **`payload_digest` 列が無い**（saga コーディネーター状態として持つのは `operation_id` / `candidate_user_id` / `reserved_until` / `saga_committed` / `locators` / `coordinator_locator` の6つ）。`payload_digest` を持つのは User Data DO 側の `operations` である。

正本の優先順位は `spec/database/index.md` > `.thread/34/design.md` なので、列を勝手に足して design.md の字面に合わせることはできない。同時に、`spec/domains/identity.md` の書き込み操作表は `reserveCredential` の冪等性を「**同じ手続き ID の再送は同じ行に収束する**」とだけ規定しており、digest には言及していない。

### Decision

- **`CredentialMappingStore.reserve` の CAS 条件は `operationId` の一致だけとする。** 同じ `operationId` の再送は既存行に収束して成功を返し、別の `operationId` は一意制約で敗北する。
- **`ReserveCredentialArgs` から `payloadDigest` を落とす。** 書き込み先の無いフィールドを署名に残すと、読み手が「どこかで照合されている」と誤読する。
- **digest の CAS は User Data DO 側に残る** — `initialize-account` と `record-credential-locator` はどちらも `operations.payload_digest` を照合する（`spec/database/index.md` が `operations` にこの列を置いている）。したがって「同じ `operationId` に違う payload」の検出は saga 全体としては失われていない。

### Consequences

- 良い点: 列一覧を逐語で写すという AC-1 / AC-2 の突き合わせ規則に例外が要らない。
- 良い点: 「どこで digest を照合するか」が `operations` の1箇所に閉じる。
- トレードオフ: Directory 単体では「同じ `operationId` で違う locator 集合」を検出できない。#37 の経路では到達不能である — `operationId` は signup ごとに request Worker が新規採番し、リクエストを跨いで再利用する概念そのものを持たない（第6.3節）。#12 が credential 変更 saga で `operationId` を跨リクエストで運ぶ形を導入するなら、そのときに列と条件を同時に足す。

---

## ADR-025: `AccountStore` に `initialize` と `matchCallerToken` を足す

### Status

Proposed

### Context

`spec/domains/identity.md` の `AccountStore` は `find` / `advanceSessionEpoch` / `advanceResetVersion` の3本である。ところが #37 の RPC エントリは2つの操作をこのポート越しに必要とする。

1. **`account` 行の作成。** signup phase 2（`initialize-account`）が `account` / `user_settings` を書いて `status = 'active'` にする（第6.3節）。3本のどれでも書けない。
2. **`caller_token` の照合。** `record-credential-locator` の束縛は `callerToken` の定数時間比較である（第5.1節 (3-d)）。`AccountState` はこの列を持たない。

`spec/database/index.md` の `account` の節は「`status` の3値遷移・`deleted_at`・`caller_token` を書くのは退会 saga の前進であり、**その書き手は #37 が DO の RPC 側で決める**」と明記して #37 に委ねている。

### Decision

- **`initialize(callerToken, now): void` を足す。** 呼び出し元は signup phase 2 の1箇所だけである。
- **`matchCallerToken(token): boolean` を足す。** getter ではなく**述語**にする — トークンをストアの外へ出さない形にすれば、DTO・ログ・`terminal_reason` へ載る経路が構造的に生まれない（AC-3 の非露出対象）。実装は `opaqueBinding.matchOpaque` を通す。
- **非集約ストアの全数（6ストア・7メソッド）は崩れない。** `account` は OCC の `version` を持つ集約ルート側のテーブルであり、`spec/domains/identity.md` も `spec/database/index.md` も明示的に非集約ストア7つの外に置いている。

### Consequences

- 良い点: `caller_token` が `AccountState` に載らないので、「読める値は必ず出力に載りうる」という前提のもとでも漏えい経路が閉じる。
- 良い点: spec が #37 へ委ねた判断に対して、記録の残る応答が返る。
- トレードオフ: ドメインポートが spec の3本から5本へ増える。退会 saga（#45）が `status` 遷移と `deleted_at` の書き手を足すとき、同じポートに更に生える。

---

## ADR-026: `CredentialMappingStore` に8本目 `recordResetRequested` を置く

### Status

Proposed

### Context

`credential_mappings.last_reset_requested_at` は `spec/database/index.md` の濫用抑止3列の1つで、用途は「リセット依頼のスロットル判定」と書かれている。ところが**書き手がどこにも割り当てられていない** — `spec/domains/identity.md` の書き込み操作表6本にも、ADR-012 が7本目として足した `reportResult` にも該当するものが無い。

一方 `.thread/34/design.md` 第5.1節は `request-password-reset` のガードを「レート制限と応答均一化のみ」と定める。読むだけで誰も書かない列を条件にすると、スロットルは恒久的に発火せず、AC-11 が要求する4ケース（登録済み / 未登録 / SSO 専用 / **スロットル中**）のうち1つが実質的に空になる。

### Decision

- **`recordResetRequested(kind, hmac, at): void` を8本目として足す。** ポートに置くのは、ジョブ行の書き込みと**同一 `transactionSync`** でなければならないからである（`enqueueJob` はコンテキスト経由でしか届かない）。
- **行の状態を問わず無条件に更新する。** スロットル中の依頼でも刻む — 刻まないと再試行で窓を開け続けられる。
- **突き合わせ規則を「非集約ストア6ストア・7メソッド + CAS 区分の `credentialMappingStore` **8**メソッド」に更新する。** ADR-012 が確立した「CAS 区分は非集約ストアの全数の外」という扱いは変わらない。
- **天井・減衰・具体値は #18 のままである。** #37 が持つのは列と更新点だけで、窓幅はアダプター内の暫定定数である。

### Consequences

- 良い点: `spec/database/index.md` の列一覧に、書き手を持たない列が無くなる。
- 良い点: AC-11 の「スロットル中」ケースが実際に振る舞いを持つので、4ケースの経路一致がテストとして意味を持つ。
- トレードオフ: ADR-012 が「7本」と書いた数が8本になる。#18 が減衰を足すときに更に増える可能性がある（減衰は読み側で計算できるので必須ではない）。

---

## ADR-027: `DirectoryLocator` の型を `packages/core/src/lib/` へ置く

### Status

Proposed

### Context

ステップ17 は `DirectoryLocator` を `packages/core/src/adapters/cloudflare/directoryLocator.ts` に置くと書いている。ところがこの型を名前で必要とするのは**アプリケーション層**である — `signupSaga`（locator を持ち回る）と `RequestContainer.directoryStubFactory`（引数の型）の2つ。

そのまま実装すると `application → adapters` の逆流になり、**AC-25 の機械検証 (ii) が実際に赤くなる**（実測でヒット1件）。`di/` は除外されるが `application/identity/signupSaga.ts` は除外されない。

これは ADR-014 が `RpcEnvelope` について解いたのと**同じ形**である（型は複数層が共有する構造的プリミティブ、実装は adapters）。

### Decision

- **型を `packages/core/src/lib/directoryLocator.ts` へ移す。** import ゼロの leaf。
- **`adapters/cloudflare/directoryLocator.ts` は `export type { DirectoryLocator }` で re-export し、導出関数（`createDirectoryLocator`）だけを持つ。** ADR-014 が `platform/envelope.ts` に re-export を禁じたのとは扱いを分ける — あちらは application 側が adapters の名前で型を取れてしまうことが問題だったが、ここは adapters 自身が自分の戻り値型を名乗るだけで、application 側は `lib/` を読む。
- 判定基準は ADR-014 と同じ「複数レイヤーが共有する構造的プリミティブか」であり、`DirectoryLocator` はプリミティブだけのプレーンなオブジェクトで振る舞いも依存も持たないので当てはまる。

### Consequences

- 良い点: AC-25 (ii) が最終状態で 0 件になる（実測で確認済み）。
- 良い点: `lib/` の基準がぶれていない — `error` / `jobKind` / `jobBudgets` / `passwordHashing` / `secretLengths` / `rpcEnvelope` / `directoryLocator` の7本はすべて同じ基準で置かれている。
- トレードオフ: `lib/` のファイルがまた1本増える。

---

## ADR-028: AC-4 の `idFromName` grep はテストハーネスを除外する形へ確定させる

### Status

採用（AC-4 の検証手段の形を確定させるもので、AC の主張そのものは変えない）。**ステップ32 の最終ゲートで確定** — 本 ADR の形の grep を実行し、一致が `application/di/serverCloudflare.ts:148` / `:158` の2行だけであることを実測した。`plan.md` の AC-4 の検証手段欄も同じ形へ更新済み。

### Context

AC-4 は「`grep -rn "idFromName\|getByName" packages/core/src apps/web/app` の一致が `application/di/serverCloudflare.ts`（とそのテスト）だけであること」と書いている。実装後の実測では、この形のままだと次が残る。

- **JSDoc の散文3件** — `serverCloudflare.ts` の「`idFromName` / `getByName` appear here and nowhere else」、`signupSaga.ts` の「client-supplied idempotency key would end up as the argument to `idFromName`」、`durable-objects/userData.ts` の「`ctx.id.name` is populated for stubs obtained through `idFromName`」。いずれも**この規約そのものを説明している記述**である。
- **テストハーネス2件** — `adapters/cloudflare/__tests__/doHarness.ts` と `adapters/cloudflare/__tests__/binding.integration.test.ts`（どちらもステップ8 で作成済み）。DO 内の `SqlStorage` を直接触るには名前で stub を引く以外に手段が無い。

これは ADR-018 が AC-25 について解いた問題と**同じ形**である（語で検査すると「正しいコメントを消して grep を通す」か「AC を無視する」の二択になる）。

### Decision

- **検査を import ではなく「呼び出し」に限り、テストを除外する形へ確定させる。**
  ```sh
  grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app \
    | grep -v '/__tests__/'
  ```
  実測でこの形の一致は `application/di/serverCloudflare.ts` の2行だけである。
- **除外の根拠を ADR-018 と揃える** — `__tests__/` はテスト対象へ実物を与えるための合成点であり、production の依存グラフではない。射程はこの検査だけで、プロダクションコードから `__tests__/` を import する経路は存在しない。
- **`application/__tests__/helpers.ts` は除外に頼らず `createRequestContainer` 経由へ直した。** 除外があっても、アプリケーション層のハーネスが合成ルートを迂回すると「production と同じ配線をテストしている」という主張が弱くなるためである。`doHarness.ts` は DO 内の SQL を直接触るのが目的なので合成ルートを通せず、除外の対象として残る。

### Consequences

- 良い点: AC-4 が着手前・着手中・最終状態のどの時点でも実行でき、規約を説明する JSDoc を書くほど検査が赤くなる逆インセンティブが消える。
- 良い点: 実質的な保証は落ちていない — production コードで DO を選ぶ点は依然 `serverCloudflare.ts` の1箇所である。
- トレードオフ: 除外が1つ増える。ステップ32 の最終ゲートで AC-4 の文面を本 ADR の形へ更新する必要がある。

---

## ADR-029: `send-mail` の `payload` に `tokenId` を載せず、依頼の `(kind, hmac)` だけを載せる

**日付:** 2026-08-03（ステップ21）
**ステータス:** 採用

### Context

steps.md ステップ21 は「`payload` に載せるのは `tokenId` だけ」と指示している。この形を実装して統合テストを書いたところ、**同一アドレスへの連打が2回目で `ConflictError("JOB_PAYLOAD_MISMATCH")` になる**ことが判明した。

- 1回目の依頼は eligible なのでトークンを発行し、`payload = { tokenId: "…" }` を書く。
- 2回目は `lastResetRequestedAt` によりスロットルされるのでトークンを発行せず、`payload = { tokenId: null }` になる。
- 行はまだ実行可能集合（`pending`）にいるので、`enqueueJob` の収束規則4（`payload_digest` の不一致は真の競合）が発火する。

**未登録アドレスでは常に `{ tokenId: null }` なので競合しない。** つまり「2回目の依頼がエラーになるかどうか」が**そのアドレスが登録済みかどうかを直接返す列挙オラクル**になる。第7.6節が「登録済み / 未登録 / SSO 専用 / スロットル中の4ケースで処理経路が完全に一致する」と決め切っている当のものを、`tokenId` を payload に載せる形そのものが壊す。

### Decision

**`payload` は依頼の入力そのもの（`{ kind, hmac }`）だけを載せる。** 送信側（`sendMail` ハンドラ）は自 bucket の行から必要なものを全部引き直す — `(kind, hmac)` で mapping を引き、`password_verifier` の有無で送るかどうかを決め、その `credential_id` の未使用・未失効トークン行を引く。

- `(kind, hmac)` は `operation_key` が既に持っている値なので、`jobs` テーブルに新しい情報を足していない。
- 4ケースの payload はバイト単位で一致するので、`payload_digest` の競合が原理的に起こらない。
- 「生トークンを載せない」という元の要求はより強い形で満たされる（トークンの**識別子すら**載らない）。

### Consequences

- 良い点: 4ケースの処理経路が「行数・`setAlarm`・応答」だけでなく **payload の中身まで**一致する。統合テストが4ケースを直接比較する形で書ける。
- 良い点: ハンドラが冪等になる。再配送は同じ生きたトークン行を引き直すだけで、payload に焼き付けた id が消費済み・失効済みになっている場合の分岐が要らない。
- トレードオフ: ハンドラの読みが1本増える（mapping → token の2段）。`issue` が同じ credential の未使用行を全削除するので、引き当たる行は高々1本である。
- **steps.md ステップ21 の記述を訂正した。** 「`payload` に載せるのは `tokenId` だけ」は、第7.6節の列挙オラクル対策と両立しない。

---

## ADR-030: `sendMail` は `encrypted_canonical` を復号して宛先を得る。書き込み側は #37 に存在しない

**日付:** 2026-08-03（ステップ21）
**ステータス:** 採用。**下記「未解決」は ADR-036 で解消済み**（`reserve-credential` が平文 canonical を受け取り、DO が RPC エントリで封をしてから予約行を書く形）
**追記（ADR-036 時点）:** 本 ADR が引き継ぎ先を求めた2点 (a) (b) は、別 Issue ではなく #37 の中で閉じた。`encryptCanonical` は本番経路（`sealCanonical` 経由）から呼ばれるようになったので、決定2「#37 の本番経路から呼ばれない」はもはや成立しない。

### Context

`MailSender.sendPasswordResetMail(to: Email, …)` は生のメールアドレスを要求する。原本の所在は設計上 `credential_mappings.encrypted_canonical` の1箇所だけであり（第6.2.1節 (a)）、復号が許される経路の1つがこのジョブである（同 (c) 1）。

ところが **#37 のどのコードもこの列を書かない。** `CredentialMappingStore.reserve` は引数を受け取る形になっているが、facade もサーガも渡していない。構造的な理由がある — 平文 canonical を持つのは request Worker だが暗号化鍵は state Worker にしか配られず（第3.2節の非重複配布）、逆に DO 側は `transactionSync` の中にいるので WebCrypto（非同期）を呼べない。

### Decision

1. **読み側だけを実装する。** `identityDirectory/canonicalCipher.ts` に AES-256-GCM の `encryptCanonical` / `decryptCanonical` を置き、AAD は `(kind, credentialId, encryptionGeneration)`、nonce は独立列。`sendMail` は列が揃っているときだけ復号し、揃っていなければ「宛先を持たない行」として何も送らずに `done` へ落ちる。
2. **`encryptCanonical` は #37 の本番経路から呼ばれない。** 統合テストが行を仕込むのに使い、`rotate-encryption`（#44）が使う。対になる半分を欠いた暗号モジュールを置かないほうが、後から書き込み側を足すときに AAD と nonce の規則が割れない。
3. **鍵は job context 経由で渡す。** `IdentityDirectoryJobContext.secrets: StateSecrets | null` を足し、DO クラスが `alarm()` の中で `readStateSecretsOrNull(this.env)` から読む。コンテナには載せない（`stateContainerConfig.test.ts` が「コンテナに秘密が載らない」を恒久ガードとして固定しているため）。未設定のまま鍵を要する経路に入ったら `SystemError(CryptoError)` で**大きな音を立てて落ちる** — 黙って `done` にすると「送ったことになっている未送信」が生まれる。

### Consequences

- 良い点: `send-mail` の E2E が「登録済みでは実際に1通送られる」ところまで検証できる。
- 良い点: 復号失敗は fail closed（`SystemError(DataIntegrityError)`）で、暗号文の付け替えが検出できる。
- **未解決:** `encrypted_canonical` の**書き込み点が存在しない**ので、実際の signup で作られた行にリセットメールは送れない。閉じるには (a) `reserve-credential` RPC が canonical を受け取り、(b) DO 側がトランザクションの外で暗号化してから予約を書く、という2点が要る。**#38 のメール配線より前に、この2点を担当する Issue が要る**（本 ADR がその引き継ぎである）。

---

## ADR-031: `resume-signup` は観測と終端だけを実装し、phase の前進は実装しない

**日付:** 2026-08-03（ステップ21）
**ステータス:** 採用

### Context

steps.md ステップ21 は `resumeSignup` に「コーディネーター予約行から phase を読んで 1b → 2 → 3 → 4 を前進させる」と書いている。ところが phase 1b〜4 は**すべて別 DO への RPC** であり、Directory bucket からそれを発行するには state 側に stub factory が要る。

**AC-4 は `idFromName` / `getByName` の出現を `application/di/serverCloudflare.ts`（request Worker の合成ルート）1箇所に閉じることを要求している**（ADR-028 でテストハーネスだけ除外済み）。state 側に stub factory を置くことは、この構造的保証そのものの引き直しにあたる。

### Decision

**#37 の `resumeSignup` は stub を要さない半分だけを実装する。**

- コーディネーター予約行（`operation_id` 一致かつ `coordinator_locator IS NULL`）を読む。
- 行が無い → 補償済みか掃除済み → `done`。
- `status='active'` または `saga_committed` あり → phase 3 を越えている → `done`。
- `reserved_until > now` → まだ TTL 内なので `rearm`（遅いだけのサーガを止まったと決めつけない）。
- TTL 切れ → **一様な終端**（`poison` + `terminal_reason: "SIGNUP_RESERVATION_EXPIRED"`）。予約行は消さない（`locators` / `candidate_user_id` / `caller_token` が #45 の唯一の材料である）。

**前進そのものは、AC-4 の境界を引き直す判断とセットで別 Issue が実装する。**

### Consequences

- 良い点: AC-27（一様な終端）と前方互換点は満たされる。
- 良い点: AC-4 の機械検証が壊れない。
- トレードオフ: 中断した signup は自動では完走しない。利用者から見ると「登録に失敗したのでやり直す」であり、再送は毎回新しい `operationId` を採番するので詰まりはしない（第6.3節）。
- **引き継ぎ:** 前進を実装する Issue は、(a) state 側の stub factory、(b) AC-4 の文面、(c) 第3.2節の配布境界（bucket が User Data DO を名指しできるか）を同時に決める必要がある。

---

## ADR-032: ハンドラが「前進不能」を返せるよう `JobOutcome` に `terminal` を足す

**日付:** 2026-08-03（ステップ21 / 22）
**ステータス:** 採用

### Context

「前進不能が確定したら一様な終端（`poison` + `terminal_reason`）」（steps.md ステップ21）を、既存の `JobOutcome`（`done` / `rearm` / `yield`）では表せない。throw すればいずれ `poison` に落ちるが、それは**リトライ予算を8回使い切ってから**であり、「確定した」という情報が失われる。`migrate-bulk` が知らない step を渡されたときも同じ形が要る（リトライしても永久に知らないままである）。

### Decision

`JobOutcome` に `{ kind: "terminal"; reason: string }` を足し、ランナーが `poisonJob` を1文で呼ぶ。**throw 経由の終端とまったく同じ終端**（`status='poison'` / `terminal_reason` / `completed_at` / `lease_until` / `owner_token` / `next_run_at` を同じ文で確定）に落ちる。

`reason` の規則は `terminal_reason` と同じ — 終端の理由と `operationId` だけで、PII と再利用可能な秘密を載せない。

### Consequences

- 良い点: 「終端は一様である」が、どの経路から来ても成立する（#45 が読む行の形が1つに保たれる）。
- 良い点: 確定した失敗に8回分のバックオフを払わない。
- トレードオフ: ハンドラが自分で終端を宣言できるようになるので、「retry すべき失敗」を `terminal` で潰す誤用が可能になる。**判断基準は「この deployment のコードのままでは何度やっても同じ結果になるか」**であり、それを `JobOutcome` の JSDoc に書いた。

---

## ADR-033: `changeTrashRetentionDays` の再計算を UoW コンテキストのメソッドとして持つ

**日付:** 2026-08-03（ステップ20）
**ステータス:** 採用

### Context

AC-10 は「保持日数の変更が**同一トランザクションで**全項目を再計算し」と要求する。ところが ADR-001 により #37 は memo / knowledge のリポジトリを作らないので、`memos` / `topics` / `documents` を書く口が `UserDataUnitOfWorkContext` に無い。facade は生の `sql` を掴んではならない（AC-5 の grep 検証）。

### Decision

`UserDataUnitOfWorkContext` に `recalcTrashPurgeAfter(retentionDays, limit): number` を足し、実装は `trashQuery.recalcPurgeAfterChunk` に委譲する。facade は設定の保存と同じトランザクションでこれを1チャンク呼び、続けて `purge-trash` を投入する（残りと再武装はジョブが持つ）。

`spec/database/index.md`「非集約ストアへの書き込み口は6ストア・7メソッド」の全数は**崩れない** — `memos` / `topics` / `documents` は集約側のテーブルであって非集約ストアではない。

### Consequences

- 良い点: AC-10 の「同一トランザクション」が字義どおり成立する。ゴミ箱が1トランザクションに収まる通常の規模では、変更した瞬間に全項目が新しい期限を持つ。
- 良い点: 超過分の安全性はジョブの**フェーズ順序**が持つ（再計算が空になるまで削除しない）ので、チャンクに割れても延長方向の誤削除が起きない。
- トレードオフ: #2〜#6 が memo / knowledge のリポジトリを作るとき、この口を残すか各リポジトリへ寄せるかを判断する必要がある。

---

## ADR-034: 起動スモークテストは request / state の2 Worker を `workers` 配列に並べて構成する

**日付:** 2026-08-03（ステップ24）
**ステータス:** 採用

### Context

steps.md ステップ24 の断片は、request Worker を Miniflare のトップレベル（`scriptPath` / `durableObjects` / `bindings`）に置き、state Worker だけを `workers: [...]` に入れる形を示している。実測すると2点で成立しない。

1. **`workers` 配列があると、その先頭が `dispatchFetch` と `getDurableObjectNamespace` の既定の対象になる。** トップレベルに request を置くと既定が `state` になり、`No Durable Object namespace binding named "USER_DATA" found in "state" worker.` で落ちる。
2. **`dist/server/index.js` はコード分割されていて `assets/*.js` を import する。** miniflare の既定モジュール規則は裸の `.js` を CommonJS と読むので、最初の `import` で `ERR_MODULE_PARSE` になる。

### Decision

- **両方を `workers` 配列に並べ、request を先頭に置く。** DO バインディングと秘密は request のエントリに、`scriptName: "state"` で state のクラスを指す。
- **request 側に `modulesRules: [{ type: "ESModule", include: ["**/*.js"] }]` を付ける。**
- **`getAlarm()` に依拠しない**（下記の実測。統合テスト側にも同じ判断が要る）。

### Consequences

- 良い点: 注入試験で両方の Worker について `Disallowed operation called within global scope` を検知できることを確認した（下記の追補）。
- トレードオフ: steps.md の断片と形が違う。断片のまま書くと「起動しないのに緑」ではなく「起動するのに赤」になる側の失敗なので、気づけないリスクは無い。

---

## ADR-035: `guardStub` は RPC メソッドを取り出して `apply` してはならない

**日付:** 2026-08-03（ステップ21）
**ステータス:** 採用（既存実装の不具合の是正）

### Context

ステップ17 が置いた `application/di/serverCloudflare.ts` の `guardStub` は、Proxy の `get` トラップで取り出した関数を `value.apply(target, args)` で呼んでいた。**この形はどの RPC 呼び出しでも失敗する** — `DataCloneError: ServiceStub serialization requires the 'experimental' compat flag.`

JS RPC の stub のメソッドは通常の関数ではなくパイプライン用のハンドルであり、`apply` / `call` で呼ぶと workerd がレシーバーを**シリアライズすべき値**として扱う。`Reflect.get` の `receiver` を省いても同じである（実測で両方赤）。

**この不具合はステップ19 で `identity.integration.test.ts` が削除されて以降、どのテストも stub 経由の呼び出しをしていなかったため検出されなかった。** ステップ21 で同テストを作り直した最初の実行で12件全部が落ちて判明した。

### Decision

`get` トラップの中で `target[property](...args)` として**プロパティのまま呼ぶ**。理由を JSDoc に残す。

### Consequences

- 良い点: request Worker → DO の経路が実際に動く。#37 のカットオーバー全体がこの1行に乗っていた。
- 良い点: `identity.integration.test.ts`（12ケース）が恒久のガードになる。
- 学び: 「合成ルートを通す」テストハーネスの価値は、ハーネス自身が使われて初めて出る。ステップ19 の削除とステップ21 の作り直しのあいだ7ステップにわたって、この経路は無検証だった。

---

## ADR-036: `reserve-credential` が平文 canonical を受け取り、DO が RPC エントリで封をしてから予約行を書く

**日付:** 2026-08-03（ADR-030 の引き継ぎ）
**ステータス:** 採用

### Context

ADR-030 は `encrypted_canonical` の**読み側だけ**を実装し、書き手が #37 のどこにも無いことを未解決として引き継いだ。実際のサインアップが作る mapping 行は3列（`encrypted_canonical` / `encryption_generation` / `encryption_nonce`）とも NULL で、`sendMail` はそれを「宛先を持たない行」として黙って `done` に落とす。**つまり本番のサインアップで作られたアカウントには、リセットメールが1通も届かない。** 統合テストが緑だったのは、テスト自身が `encryptCanonical` で暗号文を seed していたからである。

構造的な行き止まりは2つあった。**(i) 平文 canonical を持つのは request Worker だが、暗号化鍵 `IDENTITY_MAIL_ENCRYPTION_KEY` は state Worker にしか配られない**（第3.2節の非重複配布）。**(ii) 鍵を持つ DO 側は `transactionSync` の中にいるので、WebCrypto（非同期）を呼べない。**

### Decision

ADR-030 が示した closing plan (a) (b) をそのまま採る。**秘密の配布境界は動かさない。**

1. **`reserve-credential` の引数に `canonical: string`（平文）を足す。** #37 の RPC エントリで平文 canonical を取るのはこの1本だけである。`CredentialMappingKind` ごとの区別は無く、SSO の行も同じ経路で封をする（原本は鍵ローテーションの再 HMAC にも要る。第6.2.1節の動機2）。
2. **封をするのは DO クラスの RPC エントリで、`this.entry(...)` に入る前である。** (ii) の行き止まりは「エントリ自身は非同期である」ことで抜ける — `await sealCanonical(...)` の結果を値として同期コールバックへ渡す。**`run()` のコールバックの中では相変わらず何も `await` しない。**
3. **`sealCanonical(keyring | null, canonical, { kind, credentialId })` を `identityDirectory/canonicalCipher.ts` に置く。** active 世代は keyring の先頭エントリから採り、行に記録する（復号は行が宣言した世代で行うという既存規則のまま）。AAD と nonce の規則は ADR-030 のまま変えない。
4. **鍵が未設定なら予約そのものを失敗させる**（`SystemError(CryptoError)` を値エンベロープで返す）。`send-mail` の `requireKeyring` と同じ「大きな音を立てる」側に倒す。黙って NULL を書くと、**そのユーザーは以後永久にパスワードリセットできない**のに、症状が出るのは最初のリセット依頼のとき（=サインアップよりずっと後）である。鍵は DO の constructor ではなく毎回 `readStateSecretsOrNull(this.env)` から読む（constructor で投げると `alarm()` と運用診断まで道連れになる、という既存の判断のまま）。
5. **ポートの3列を `sealedCanonical: SealedCanonical`（必須の1値）に畳む。** 3つの optional は「2列だけ書かれた行」を型で許してしまい、その行は二度と開けない。予約は必ず封を伴う、を型で言い切る。

**AC-3 に反しない。** AC-3 が禁じるのは (a) DO の ID / routing key に生アドレス・SSO subject を使うこと、(b) canonical / hmac / locator / 各種トークンが**ログ・エラー・URL** に出ること、の2つである。ここで平文が乗るのは信頼境界の内側への RPC 引数であり、量は1サインアップにつき1件で、第5.2.3節が制約として固定した「平文 canonical を Worker 境界の外へ **bulk** で出さない」にも当たらない（第6.2.1節 (c) 4 の `read-own-canonical` が逆向きに1件だけ越えるのと同じ性質）。ADR-016 が定めた責務配置（canonical 化と HMAC 導出は request Worker、bucket は `(kind, hmac)` で引く）も動かない — **引くキーは今も `(kind, hmac)` だけ**であり、bucket は routing secret を持たないので平文から自分の名前を導けない。

**列挙オラクルも壊さない。** ADR-029 が守っているのは `request-password-reset` → `send-mail` の4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）の経路一致であって、`reserve-credential` はその経路に無い（サインアップは元から「登録済みなら `EMAIL_ALREADY_REGISTERED`」を返す）。封は行の有無を見る**前に**無条件で行われるので、暗号化の有無で分岐する観測点も生まれない。

### Consequences

- 良い点: **実際のサインアップ → リセット依頼 → `send-mail` で宛先が復元できる。** 統合テスト `identity.integration.test.ts` に、seed を一切使わずこの経路を通す1本（と、行の3列が埋まることを見る1本）を足した。
- 良い点: `encryptCanonical` / `decryptCanonical` が対になって本番経路に乗ったので、AAD・nonce・世代の規則が「テストとローテーションだけが知っている」状態を脱した。#44 の `rotate-encryption` は同じ規則を再利用できる。
- トレードオフ: **`IDENTITY_MAIL_ENCRYPTION_KEY` がサインアップの必須バインディングになった。** 未設定のデプロイはサインアップが失敗する（従来はサインアップだけ通って、リセットが黙って壊れていた）。`vitest.config.integration.ts` は両鍵を束ねているので統合スイートは影響を受けない。`.dev.vars.example` に state 側2鍵の記載が無い件は #37 のステップ27 の宿題として残っている（本 ADR の射程外）。
- トレードオフ: `reserveCredential` だけが `this.entry(...)` の外で仕事をする非対称な形になった。理由（WebCrypto が非同期・UoW コールバックが同期）を DO クラスの JSDoc に残した。
- 非スコープ: `read-own-canonical`（設定画面の自アドレス表示。第6.2.1節 (c) 4）は #12 のまま。今回足したのは**書き込みと、ジョブからの復号**だけである。
- 隣接修正: `canonicalCipher.ts` の AAD 区切り子が**生の NUL バイト**で書かれており、`git` / `grep` がこのファイルを binary 扱いしていた（`ssoCanonical` 側は最初からエスケープ表記で、規則もそこに書かれている）。`\u0000` のエスケープ表記へ直した。**エンコードされるバイト列は同一**なので暗号文の互換性には影響しない。放置すると AC-3 の禁止語 grep を含む機械検査がこのファイルに対して無言で0件を返す。

---

## 付録: spike の実測結果

**実測日:** 2026-08-03
**環境:** `@cloudflare/vitest-pool-workers@0.16.20` → `miniflare@4.20260625.0`（workerd 同梱版）、`durableObjects: { PROBE: { className, useSQLite: true } }`、`main` を `WorkersPoolOptions` のトップレベルに置いた形。
**再現手段:** `packages/core/src/adapters/cloudflare/__spike__/platform.integration.test.ts`（12項目。ステップ9 / 10 で常設テストへ移植したのち削除する使い捨て）。

| # | 項目 | 結果 | 設計への影響 |
|---|---|---|---|
| 1 | `CREATE VIRTUAL TABLE search_fts USING fts5(…, content='search_entries', content_rowid='rowid', tokenize='trigram')` | **作れる**。`sqlite_master` に現れる `type='table'` は `search_entries` / `search_fts` + shadow **4件**（`search_fts_config` / `search_fts_data` / `search_fts_docsize` / `search_fts_idx`）。**`search_fts_content` は作られない** | `.adr/003` の前提が成立。AC-1 の「shadow 4件を除外する」数え方が実測どおり |
| 2 | `search_fts MATCH '東京駅'`（3文字） | 3件中 **2件**（`東京駅の構内` / `東京駅の周辺`）が返る | trigram が日本語で期待どおり動く |
| 3 | `bm25(search_fts, 3.0, 1.0)` | 例外なく順位を返す（値は負。SQLite 慣行どおり**昇順で良い順**）。実測 `-1.6923e-6` ×2 | `ORDER BY bm25(...)` を昇順で使う |
| 3b | **2文字クエリ `周辺` を `MATCH` に渡すと 0 件** | **steps.md ステップ1 の項目3 / 項目5 が指定した検証キーワード `周辺` は2文字で、trigram では原理的にヒットしない。** 3文字以上（`駅の周辺`）に差し替えて再実行し、2件返ることを確認した | **短語フォールバック（`instr()`）が必須であることの実測的裏付け。** ステップ9 の常設テストは「3文字以上は `MATCH`、2文字以下は `instr()`」の両方を固定する |
| 4 | `instr(title, ?) > 0 OR instr(body, ?) > 0` に2文字 `東京` | **2件**返る | 短語フォールバックが成立 |
| 5 | `駅の周辺` を `LIMIT 1 OFFSET n` で2ページに割る | 1ページ目 `b` / 2ページ目 `c` で別項目 | ページングが破綻しない |
| 6 | `snippet()` / `highlight()` | **どちらも使える**（`[東京駅]の構内を歩く` / `[東京駅]の構内`） | F-13 の不確実性は解消。ただし設計はこれに依存していないので結論は動かない（#10 が使ってよい） |
| 7 | `transactionSync` のネスト | **可能**。内側は savepoint 相当で、内側が throw して呼び出し側が握り潰すと**内側の書き込みだけがロールバックし外側はコミットされる**（実測: 外側 `a=2` が残り、内側 `a=3` が消えた） | ネストは技術的に可能だが、`CLAUDE.md`「never call `run` from inside `run`」の禁止は**規約として維持する**（部分ロールバックが暗黙に成立してしまうため、むしろ禁止の必要性が上がった） |
| 8 | `UPDATE … WHERE … RETURNING 1` | **使える**。一致時 `[{"1":1}]`、0行時 `[]`。参考: `SELECT changes()` も直前 DML のマッチ行数（1）を返し、`SqlStorageCursor.rowsWritten` も 1 を返す | 第8.4節の OCC 実現手段（`RETURNING 1` の行有無）がそのまま成立。`changes()` / `rowsWritten` は不要 |
| 9 | 1クエリの結果セット合計サイズ上限 | **miniflare では上限に当たらない** — 64 KiB × 4,096行（**256 MiB**）を1クエリで読み切っても例外が上がらない | **ローカル実測では上限値を確定できない。** export 上限の根拠値は公式ドキュメントの記載から採るしかないので、**#38 へ「実測不能」として引き継ぐ**（この値に依存する設計は #37 に無い） |
| 10 | `sql.exec()` が `Date.now()` を進めるか | **進む**。SQL 2万回で 33ms、**I/O を一切含まない純 CPU ループ（2千万回）でも 19ms 進んだ** | **miniflare では workerd の時刻凍結が再現しない**（凍結の射程を実測で確認できない）。したがって F-32 の保守的な読みを維持し、**チャンク予算の打ち切りは経過時間ではなく件数だけで有界にする**（設計は元から件数基準なので変更なし） |
| 11 | Alarm / RPC が CPU リセットの契機か | **観測不能**。miniflare は CPU 時間制限を強制しないので、リセットの契機を実験で確定できない（`setAlarm` の存在のみ確認） | 保守的な読み（「エビクションは例外として観測できない」「`finally` に再武装を置かない」）を**そのまま維持する** |
| 12 | `(iii-a)` 1,000行 / `(iii-b)` 20チャンクの初期値 | 10万行を1トランザクションで INSERT: **223ms**。`WHERE status='trashed' AND purge_after <> <新値> LIMIT 1000` の自己消尽チャンクで全件再計算: **101チャンク / 346ms**（≒**3.4ms/チャンク**） | 初期値は**十分に保守的**。20チャンク/起床 = 2万行 ≒ 70ms で、Alarm 1回の予算に対して余裕がある。`CHUNK_BUDGETS` の出発点（1,000行 / 20チャンク）を**変更せずに採用する** |

**環境設定について実測で確認した2点**（steps.md ステップ1 / 7 の記述どおり）:

- `main` は `WorkersPoolOptions` の**トップレベル**に置く必要がある（`miniflare` の中に書くと無視される）。
- `durableObjects` の値に **`useSQLite: true` が必須**。落とすと KV バックエンドになり `ctx.storage.sql` が存在しない。

**steps.md への差し戻し:** ステップ1 項目3 / 項目5 の検証キーワード `周辺`（2文字）は trigram では 0 件になる。ステップ9 の常設テストへ移植する際は**3文字以上のキーワード**（`駅の周辺`）を使い、2文字は `instr()` フォールバック側のケースとして固定する。

### 付録の追補: ステップ10 で判明した Alarm の実測事実

| 事実 | 実測 | 影響 |
|---|---|---|
| `setAlarm(t)` に**過去時刻**を渡すと、`getAlarm()` が返すのは `t` ではなく**ほぼ現在時刻**である | miniflare 上で `setAlarm(40_000)`（epoch ミリ秒 = 1970年）の直後に `getAlarm()` が `1785702532310`（実行時刻）を返した | プラットフォーム側が過去のアラームを「即時」に丸めるということであり、**設計の `clamp(now, at)`（過去・現在の due job を `now + 1000` へ寄せる）はこの丸めに依存せず自前で行う必要がある**（丸め後の値が読み戻せないと `AlarmCache` の比較が毎回外れて `setAlarm` を書き続ける）。統合テストは絶対時刻を**未来基準**（`Date.now() + 3_600_000` からのオフセット）で書く — 過去時刻の定数だと `getAlarm()` が壁時計を返して何も検証しないテストになる |

### 付録の追補: ステップ20〜24 で判明した実測事実

| 事実 | 実測 | 影響 |
|---|---|---|
| miniflare の `getAlarm()` は、**武装済みで未配送の alarm に対して `null` を返す** | `requestPasswordReset` の直後に `getAlarm()` が `null`、300ms 後に同じジョブ行が `done` になっていた（alarm は確かに発火している） | **統合テストで `getAlarm()` を観測手段に使えない。** 設計が「`getAlarm()` を呼ばず `AlarmCache` で比較する」と決めているのと同じ理由が、テスト側にも及ぶ。alarm の効果は「キューされた仕事が実行されたか」で観測する |
| `dist/server/index.js` はコード分割されており `assets/*.js` を import する | miniflare の既定モジュール規則では `ERR_MODULE_PARSE`（`'import' and 'export' may appear only with 'sourceType: module'`） | スモークテストの request Worker に `modulesRules: [{ type: "ESModule", include: ["**/*.js"] }]` が要る（ADR-034） |
| `workers` 配列の**先頭**が `dispatchFetch` / `getDurableObjectNamespace` の既定対象になる | request をトップレベルに、state だけを `workers` に置くと `No Durable Object namespace binding named "USER_DATA" found in "state" worker.` | 両方を配列に並べ、request を先頭に置く（ADR-034） |
| global scope 制約違反の注入試験 | `apps/web/app/worker/cloudflare/state.ts` と `apps/web/app/server.cloudflare.ts` のそれぞれに module スコープの `crypto.randomUUID()` を1行足して `pnpm build:cf && pnpm test:smoke` を実行し、**両方とも** `service core:user:{state,request}: Uncaught Error: Disallowed operation called within global scope.` で赤になることを確認した。確認後に両ファイルを元へ戻し、`git diff` が空であることを確認済み | AC-22 / AC-23 の「実行時に検知できる」が実測で裏づけられた。#40 の再発は request / state のどちら側でも捕まる |
| `purge-trash` の安全弁（駆動源が due なのに作業0件だったらクランプする）は、**駆動源クエリと作業述語が一致している限り到達不能である** | 両者とも `status='trashed'` の同じ `purge_after` を見るので、`min(purge_after) <= now` なら必ず削除対象がある | クランプは防御として残したが、テストは代わりに**不変条件**（1回の起床の後、駆動源は必ず未来にある）を固定した。到達可能にするには両クエリを意図的にずらすしかなく、それは検査したい不具合そのものである |

---

## ADR-037: `pnpm dev` は state Worker を vite プラグインの auxiliary worker として起動する

**日付:** 2026-08-03
**ステータス:** 採用

### Context

ステップ25 が `apps/web/wrangler.toml`（request 側）の DO バインディング2本に `script_name = "fog-state"` を書くと決めている。DO クラスの所有者は state Worker であり、request Worker がクラスを宣言しないための必然の帰結である。

ところが **steps.md にはローカル開発でその `fog-state` を誰が起動するのかが書かれていない。** `@cloudflare/vite-plugin` は `apps/web/wrangler.toml` だけを自動発見するので、`pnpm dev` は request Worker しか立ち上がらず、`script_name` の指す先が存在しない。にもかかわらずステップ25 とステップ32 の検証欄は「`pnpm dev` でサインアップ・ログインが通る」を要求している。実測でも、この状態では DO 呼び出しに到達した時点で失敗する。

`dev:state`（`wrangler dev -c wrangler.state.toml`）はステップ26 で新設するが、これは**別プロセス**であり、`vite dev` が起動する miniflare とはバインディングを共有しない。2つのターミナルを開いても request 側の `USER_DATA` は解決しない。

### Decision

**`apps/web/vite.config.cloudflare.ts` の `cloudflare()` に `auxiliaryWorkers` を1件足す。**

```ts
auxiliaryWorkers: [
  {
    configPath: "./wrangler.state.toml",
    devOnly: true,
    config: { main: "app/worker/cloudflare/state.ts" },
    viteEnvironment: { name: "state" },
  },
],
```

3つの指定はそれぞれ別の理由を持つ。

- **`configPath`** — バインディングと `exports` の宣言を `wrangler.state.toml` から引く。設定を2箇所に書かない。
- **`devOnly: true`** — デプロイ用の state Worker を作るのは `vite.config.state.ts`（`build:cf` の2段目）である。これを落とすと `vite build --config vite.config.cloudflare.ts` が state Worker をもう1部、別の出力先へ吐く。
- **`config: { main: ... }`** — `wrangler.state.toml` の `main` は `dist/state/index.js`（成果物）だが、vite プラグインは auxiliary worker の `main` も**ソースエントリとして解決し、存在しなければ throw する**。ステップ25 が「ローカル `wrangler.toml` の `main` を成果物へ向けてはならない」と実測した制約が、そのまま auxiliary 側にも掛かる。ファイル側は成果物のままにして（`wrangler dev -c wrangler.state.toml` と `--dry-run` はそちらを必要とする）、vite 経路だけを上書きする。

**steps.md ステップ25 の「`vite.config.*` には触らない」に対する例外である。** 同ステップの目的（wrangler 設定の2次元化）と同ステップの検証条件（`pnpm dev` が通る）が両立しないので、検証条件のほうを成立させた。

### Consequences

- 良い点: `pnpm dev` の1コマンドで両 Worker が立ち、DO 越しのサインアップ → ログイン → 設定 → ログアウトが通る（agent-browser で実測）。
- 良い点: `.wrangler/deploy/config.json` の `auxiliaryWorkers` は `[]` のままである（`devOnly` なので production の redirect 設定に載らない）。AC-26 の判定に影響しない。
- トレードオフ: ローカル開発では両 Worker が同じ `apps/web/.dev.vars` を読むので、**秘密の配布境界がローカルでだけ守られない。** wrangler が設定ファイルの隣の `.dev.vars` を読む仕様による制約であり、デプロイ経路は役割別の設定に対して `wrangler secret put` するので影響しない。`.dev.vars.example` にその旨を明記した。
- トレードオフ: `wrangler.state.toml` の `main` が経路ごとに2つの意味を持つ（wrangler は成果物、vite は上書きされたソース）。両ファイルにコメントで理由を残した。

---

## ADR-038: `worker-configuration.d.ts` の D1 / Queue 検査は生成された env インターフェース部分に限る

**日付:** 2026-08-03
**ステータス:** 採用

### Context

steps.md ステップ25 は「`grep -n "D1Database\|Queue<\|EVENTS_QUEUE" apps/web/worker-configuration.d.ts` が 0 件」を検証条件に置いている。実際に `wrangler types` で再生成すると、**この条件は原理的に満たせない。**

`wrangler types` が出力するファイルは2部構成である。前半は wrangler 設定から導いた env インターフェース（`__BaseEnv_Env`）、後半（`// Begin runtime types` 以降）は compatibility date / flags から生成した **workerd のランタイム型一式**である。後半には `D1Database` の宣言が5件、`interface Queue<Body = unknown>` が1件、必ず含まれる — バインディングを1つも持たない Worker でも同じである。

### Decision

**検査の射程を `// Begin runtime types` より前に限る。**

```sh
n=$(grep -n "^// Begin runtime types" apps/web/worker-configuration.d.ts | cut -d: -f1)
head -n "$((n-1))" apps/web/worker-configuration.d.ts | grep -n "D1Database\|Queue<\|EVENTS_QUEUE"   # 0 件
head -n "$((n-1))" apps/web/worker-configuration.d.ts | grep -c "DurableObjectNamespace"             # 2 件
```

AC-17 / AC-19 が守りたいのは「**この Worker のバインディングに** D1 / Queue が残っていないこと」であり、それを表しているのは前半だけである。後半はプラットフォームが提供する型の目録であって、このリポジトリの設定を1文字も反映しない。

### Consequences

- 良い点: 実測で前半に D1 / Queue の一致は 0 件、`DurableObjectNamespace` が `USER_DATA` / `IDENTITY_DIRECTORY` の2件で、AC の意図どおりに判定できる。
- 良い点: `wrangler types` の `includeRuntime` を切って検査を通す、という「検査のために型を痩せさせる」倒錯を避けられた。
- 補足: **steps.md はこのファイルを「tracked な生成物」と書いているが誤りである。** 実測で `.gitignore:12` に `worker-configuration.d.ts` があり、`git ls-files` にも現れない。`postinstall` / `predev:cf` の `wrangler types` が各環境で作る。したがって「再生成しないと古い D1 型が tracked ファイルに残る」という懸念は成立しないが、**再生成しないとローカルの `pnpm typecheck` が落ちる**ので、再生成そのものは必要である。

---

## ADR-039: 旧 `deploy:*` 対応表は README に残し、ステップ26 の README grep はその表を除外する

**日付:** 2026-08-03
**ステータス:** 採用

### Context

steps.md ステップ26 は2つのことを同時に要求している。

1. 旧 `deploy:*` ↔ 新スクリプトの**対応表を README の該当節に残す**（AC-18 も「対応表が残っており」と要求）。
2. `grep -n "D1\|Queues\|outbox\|relay\|consumer\|pruner\|DLQ\|db:" README.md` が **0 件**。

対応表の左辺には `deploy:{stage}:relay` / `:consumer` / `:pruner` / `:dlq` が現れる。**両立しない。**

### Decision

**対応表を残し、grep の射程からその1行を除外する。** 除外の根拠は AC-20 が `spec/idea.md` を除外するのと同じ性質 — **歴史的記述であって、現行構成の案内ではない。** 表の右辺は「gone — those Workers no longer exist」であり、読み手を消えた機構へ誘導しない。

判定は次の形で行う。

```sh
grep -n "D1\|Queues\|outbox\|relay\|consumer\|pruner\|DLQ\|db:" README.md | grep -v 'gone — those Workers no longer exist'   # 0 件
```

### Consequences

- 良い点: 旧スクリプト名から新スクリプトへ辿れる導線が残る。名前が消えただけの変更は、対応表が無いと利用者が「消された」のか「改名された」のか判断できない。
- トレードオフ: 除外が1つ増える。表を消す判断は #41（README / docs の乖離解消）が、対応表の役目が終わったと判断した時点で行えばよい。

---

## ADR-040: request Worker の `--dry-run` 検証対象はローカル `wrangler.toml` ではなく rendered `wrangler.request.<stage>.toml` である

**日付:** 2026-08-03
**ステータス:** 採用

### Context

steps.md ステップ32 の項目9 は `npx wrangler deploy -c wrangler.toml --dry-run` の成功を求めている。**これはステップ25 自身の決定と矛盾する。**

ステップ25 は、`@cloudflare/vite-plugin` が `apps/web/wrangler.toml` の `main` をソースエントリとして解決するので、この1本だけは `main = "app/server.cloudflare.ts"` に据え置くと決めた。ところが wrangler にとってソースエントリは esbuild でバンドルする対象であり、TanStack Start の仮想モジュール（`tanstack-start-manifest:v` など）を解決できない。実測でも `--dry-run` は `Could not resolve "tanstack-start-manifest:v"` で失敗する。

**この失敗は欠陥ではない。** `apps/web/wrangler.toml` はファイル冒頭が明記するとおり **LOCAL DEV ONLY** であり、`wrangler deploy` の対象ではない。デプロイに使う設定は `.tpl` からレンダリングした `wrangler.request.<stage>.toml` で、そちらは `main = "dist/server/index.js"` を指す。

### Decision

**request 側の `--dry-run` 検証対象を rendered `wrangler.request.<stage>.toml` に読み替える。** state 側はローカル `wrangler.state.toml` と rendered の両方が成果物を指すので、両方を対象にする。

実測（wrangler 4.114.0、`.wrangler/deploy/config.json` が `../../dist/server/wrangler.json` への redirect を持つ状態）:

| 対象 | 結果 |
|---|---|
| `-c wrangler.state.toml` | 成功。バンドル入口は `dist/state/index.js`、バインディングは自己参照の DO 2本 |
| `-c wrangler.state.staging.toml` / `.production.toml` | 成功。同上 + `APP_URL` がステージ値 |
| `-c wrangler.request.staging.toml` / `.production.toml` | 成功。バンドル入口は `dist/server/index.js`、DO 2本が `fog-{stage}-state` の定義を指す、ASSETS 37ファイル |
| `-c wrangler.toml` | **失敗（想定どおり）。** ソースエントリを wrangler が直接バンドルできない |

### Consequences

- 良い点: **AC-26 が実測で満たされた** — redirect 設定が存在する状態で、明示 `-c` を渡した4本ともそれぞれ自分の `main` をバンドルし、redirect 先（`dist/server/wrangler.json`）へ引きずられなかった。`[env.*]` を使わない構成なので #40 §5 の踏み方自体が発生しない。
- トレードオフ: 「ローカル `wrangler.toml` は `wrangler deploy` に使えない」という性質が、コメントだけでなく検証手順にも現れた。README とファイル冒頭コメントの両方で明示してある。
- 補足: `pnpm start`（`wrangler dev`、`-c` なし）は redirect が効くので `dist/server/index.js` を起動し、**正常に応答する**（実測: `GET /login` が 200）。`pnpm preview` も同様。#40 は解消済みである。

---

## ADR-041: `@repo/web` の `test:smoke` はルートスクリプトへのパススルーにする

**日付:** 2026-08-03
**ステータス:** 採用

### Context

3つの vitest 設定（`vitest.config.ts` / `.integration.ts` / `.smoke.ts`）はすべてリポジトリルートにあり、`include` もルート基準のパスで書かれている。したがって `test:unit` / `test:integration` / `test:smoke` はいずれもルートにしか存在せず、`@repo/web` 側の対応スクリプトは無い。

一方でスモークテストの対象（`apps/web/__tests__/**/*.smoke.test.ts` とビルド成果物 `apps/web/dist/`）は `apps/web` に閉じており、`apps/web` の中で作業しているときに `test:smoke` が見つからないのは発見性が悪い。

### Decision

**`@repo/web` に `"test:smoke": "pnpm --workspace-root test:smoke"` を置く。** 設定を複製せず、ルートの1本を呼ぶ。

`vitest.config.smoke.ts` を `apps/web` から相対参照する案は採らない — vitest の root が `apps/web` になって `include` のパスが総崩れになるため、設定側にも `root` 指定の追加が要り、ルートと web で2通りの解釈が生まれる。

### Consequences

- 良い点: `pnpm --filter @repo/web test:smoke` と `cd apps/web && pnpm test:smoke` のどちらでも動く。
- トレードオフ: **ルート → web という委譲の向きに対して逆向きの1本ができた。** 再帰の危険は無い（ルートの `test:smoke` は `vitest run` を直接呼び、web へ委譲しない）が、ルート側を委譲形に変える場合はこの1本を先に外す必要がある。
- 非対称: `test:unit` / `test:integration` には web 側の対応を置かない。どちらも `packages/core` を含む複数パッケージに跨るので、`@repo/web` の名前空間に置くと射程を誤解させる。スモークだけが `apps/web` に閉じている。

---

## ADR-042: リセットトークンは「発行・配送・検証」を1つの導出鎖に閉じ、行にはメール本文の秘密の SHA-256 だけを残す

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー adapter-infra B-003 / security B-001 / security W-001 への対応）

### Context

レビュー2本が独立に同じ設計欠陥へ到達した。実装は3者が別々の値を扱っていた。

- 発行（`resetTokenStore.issue`）: `token_id`（128bit 乱数）を PK 列に**平文で**書き、`token_hash` にはその FNV-1a-64 を書く
- 配送（`sendMail`）: 利用者へ渡すのは `{routingGen}.{bucket}.{HMAC(IDENTITY_RESET_TOKEN_KEY, tokenId)}`
- 検証（`verifyAndConsume(token)`）: `token_hash = FNV(token)` で引く

この3つは決して噛み合わない。メールの値からは行へ辿り着けず（機能として死んでいる）、逆に `token_id` 列の値をそのまま出せば必ず一致する（DB 読み取り漏えいで全リンクが消費可能）。さらに FNV-1a-64 は非暗号学的で第二原像耐性が無い。`spec/database/index.md`:627 と `passwordResetTokenPort.ts` の JSDoc が主張する「生トークンは保存しない/DB 漏えいでトークンは使えない」は、いずれも成立していなかった。

「ポートが同期だから WebCrypto を使えない」は理由にならない。**同じ制約を同じ PR が別の場所で解いている** — `reserve-credential` は封緘を `run()` の外（非同期な RPC エントリ）で済ませ、暗号文を値としてトランザクションへ渡す（ADR-036）。

### Decision

導出鎖を1本に確定し、その1本だけを共有モジュール
`adapters/cloudflare/identityDirectory/resetTokenCrypto.ts` に置く。

```
tokenId  --HMAC(IDENTITY_RESET_TOKEN_KEY[gen])-->  secret
secret   --SHA-256-------------------------------> token_hash（行に載る唯一の照合材料）
secret   --routing 座標を前置---------------------> メール本文のリンク
```

- **導出は DO の RPC エントリで行う。** `requestPasswordReset` を `reserveCredential` と同じ形にし、`mintResetTokenMaterial(keyring)` が `{ tokenId, tokenHash, tokenKeyGeneration }` を作ってから `run()` へ値で渡す。ポートは同期のまま、WebCrypto の SHA-256 / HMAC が使える。
- **`PasswordResetTokenPort` の契約を変える。** `issue(credentialId, material, now): void`（`string` を返さない）／`verifyAndConsume(tokenHash, now, operationId)`。**両方とも「導出済みの値を受け取る」**ことを契約として明文化する。#12 の消費エントリも同じモジュールで `parseResetToken` → `resetTokenDigest` を行い、同期ポートへ primitive を渡す。
- **`token_id` は行の識別子に徹し、証明としては一切受け付けない。** 行が引かれる鍵は「導出された `secret` の SHA-256」なので、`token_id` を提出しても、`token_hash` をそのままリンクとして提出しても一致しない。
- **導出は不適格でも無条件に実行する。** 4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）の一様性を守るため、エントリは常に2回の WebCrypto 操作を払い、facade が不適格なら結果を捨てる。
- **`activeResetTokenGeneration` の DI 経由の受け渡しを廃止する。** 世代は導出点（エントリ）が keyring から決め、`material` に載せて行まで運ぶ。DO のコンストラクタで keyring を読まなくなるので、未設定の任意バインディングが `alarm()` を巻き添えにする経路も同時に消える。

### Consequences

- 良い点: 行 + 鍵の分離が実際に成立する。ダンプは鍵を持たず（`secret` を作れない）、SHA-256 の原像も作れない。`token_id` を提出する攻撃は構造的に成立しない。
- 良い点: 発行 → メール本文のリンク → 検証が**実際に合成できる**。`identityDirectory/__tests__/resetToken.integration.test.ts` が実 DO クラスの RPC エントリから送信ジョブ経由でリンクを取り出し、そのリンクだけを入力に消費まで通す。
- 良い点: `verifyAndConsume` が「誰も満たせない引数」を持ったまま #12 へ渡ることが無くなった。
- トレードオフ: `IDENTITY_RESET_TOKEN_KEY` 未設定のデプロイでは `request-password-reset` が `SystemError(CryptoError)` の封筒を返す（従来は send-mail ジョブ側で落ちていた）。失敗は宛先に依存しないので列挙オラクルにはならず、「鍵が無いのにリクエストを成功と記録する」ほうが悪い。
- 引き継ぎ: `spec/database/index.md`:627 / :649 と `spec/inventory/adapter.md` の「`token_id` から導出したハッシュを保存する」は**実装と食い違う記述として残る**。spec は本担当のファイル範囲外なので直していない（`.thread/37/review/triage.md`）。

---

## ADR-043: `send-mail` の `operation_key` に時間窓を入れ、トークン発行スロットルと同じ数値を共有する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー adapter-infra B-001 / security W-002 への対応）

### Context

`SEND_MAIL_EMPTY_RETENTION_MS`（15分）は JSDoc で「`send-mail` は再武装しない種別なので、生き残った `done` 行が再依頼を拒む側であり、この値がそのままスロットル窓である」と宣言していたが、**参照するコードが1行も無かった**。`pruneCompleted` は種別を見ず `DONE_RETENTION_MS`（24時間）を一律に適用していた。

結果として、`RESET_THROTTLE_MS`（60秒）を過ぎた2回目の依頼は「発行は通るが投入は弾かれる」状態になる。`issue` は同一トランザクションでその credential の未使用行を**全削除してから**新しい行を書くので、**利用者が手元に持っている生きたリンクだけが壊れ、新しいリンクは24時間届かない**。しかも応答は成功と区別できない。

### Decision

「トークンを発行するなら必ずメールが出る」を**構造で保証する**。

- `operationKey` / `providerIdempotencyKey` を `send-mail:{kind}:{hmac}:{floor(now / RESET_REQUEST_WINDOW_MS)}` にする（`spec/database/index.md`:24 が言う「対象と時間窓から導く種別」）。
- **発行スロットル窓を同じ定数にする。** `RESET_REQUEST_WINDOW_MS` 1本が両方を決める。

この等式が不変条件を厳密にする — 発行の条件は `last + window <= now` であり、これが成り立つとき `floor(now/window) > floor(last/window)` が必ず成り立つ。つまり**発行できる依頼は必ずまだ行の無い `operationKey` に着地する**。逆に同じ窓の2回目は必ず発行が拒まれるので、生きたリンクが黙って壊れることも無い。

- `pruneCompleted` は種別ごとの保持期間を取る（`{ done, poison, sendMail }`）。`send-mail` の保持は `SEND_MAIL_RETENTION_MS`（= 窓）で、**結果によらず一律**である（「宛先が無かった行だけ短く保つ」は保持時間が結果に依存する＝列挙オラクルになる。security W-002）。定数名から `EMPTY` を落としたのはこの理由による。

### Consequences

- 良い点: 死に定数が消え、宣言されていた15分の窓が実際にその意味を持つ。
- 良い点: 窓ごとに `providerIdempotencyKey` が変わるので、プロバイダ側が正当な再依頼を前回の送信と重複排除する副次問題も同時に消える。
- 良い点: バースト連打は依然1行へ収束する（同じ窓なので同じキー）。
- トレードオフ: 1アドレスにつき窓ごとに `jobs` 行が1本増えうる。保持が窓と等しいので蓄積は有界（最大でも直近1窓ぶん）。
- トレードオフ: 窓は floor 分割なので、窓境界の直前と直後の依頼は実質1分間隔でも2通届きうる。スロットル側は sliding なのでトークンは1つしか出ず、2通目は同じ生きたリンクを再送するだけである。運用値の調整は #38。

---

## ADR-044: `alarm()` は4段すべてを1つの catch で包み、失敗はすべて fail-closed と同じ終端に寄せる

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー adapter-infra B-002 への対応）

### Context

`alarm()` の本体は「再武装 → ゲート → 実行 → settle」の4段だが、`try / catch` が掛かっていたのは2段目のゲートだけだった。`rearmBeforeWork` / `runDueJobs` 内の `listRunnable` / `claimJob` / `pruneCompleted` / `settleAlarm`、および `runOne` の catch 節が呼ぶ `poisonJob` / `failJob` はいずれも裸である。

CLAUDE.md「非同期実行契約」(5) は無条件に「Never throw out of `alarm()`」と書く。しかもこれは机上の話ではない — `spec/database/index.md`:20 は「逼迫時は書き込みだけが失敗し読みと削除は通る」を設計前提として明記しており、10 GB に達した DO ではまさに `claimJob` の `UPDATE` が `SQLITE_FULL` で失敗する。`purge-trash`（＝容量を空ける唯一の自動経路）が二度と claim できない。

### Decision

- 両 DO クラスの `alarm()` を **4段すべてを包む1つの `try`** にし、catch は共有ヘルパ `rearmAfterFailure(ctx, cache, logger, now, error)` へ落とす。ヘルパは `errorIdentity` でログし、`rearmFailClosed` を内側の `try` 付きで呼ぶ（再武装自体が失敗しても throw しない）。
- **fail-closed と同じ終端に寄せる。** どの失敗も「原因は特定のジョブのデータではない」ので `poison` にはせず、固定間隔で起き直す。`deleteAlarm()` はしない。
- `runOne` の catch 内の `poisonJob` / `failJob` には**内側のガードを置かない**。ストレージが `UPDATE` を受け付けないならキューの残りも前進できないので、throw でその起床を止めるのが正しい。その意図を JSDoc に明示した。

### Consequences

- 良い点: AC-13「`alarm()` から throw しない」が、migration ゲート以外の経路でも成立する。
- 良い点: `errorIdentity` を `lib/errorIdentity.ts` の leaf に切り出したので、`terminal_reason`・ランナーのログ・`alarm()` のログが同じ射影を共有する（従来は runner.ts 内の私有関数で、60行下のログ行だけがそれに従っていなかった）。
- トレードオフ: ゲート専用だった "migration gate is fail-closed" というログ文言が "alarm wake-up failed" に一般化した。原因の識別は `cause`（`Name:CODE`）が持つ。
- 検証: `__tests__/alarmEntry.integration.test.ts` に「ストレージ側が throw するケース（`jobs` テーブルを落とす）でも `alarm()` が throw しない」を1本追加した。

---

## ADR-045: ジョブランナーのログは `operation_key` ではなく相関 ID を出す

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー security B-002 への対応）

### Context

`runner.ts` は失敗のたびに `logger.error("job failed", { operationKey: row.operation_key, …, cause: error })` を出していた。`send-mail` の `operation_key` は **canonical アドレスの完全長 HMAC を含む**（`lib/directoryLocator.ts` 自身が「identity — it is what a mapping row is keyed by」と書いている値）。AC-3 は「HMAC がログに出ない」を受け入れ条件にしている。同じファイルの `terminalReasonFor` が「任意のエラー文字列は canonical / hmac / locator / caller token / reset token を含みうる」と明記して message を捨てているのに、その60行下でその message をログへ流していた。

そしてこの穴はテストで意図的に見逃されていた（`runner.integration.test.ts` が `lines` を `assertNoForbiddenValue` に掛けていなかった）。

### Decision

- `operationKey` を落とし、`job: SHA-256(operation_key) の先頭8バイト` を出す。ログ行どうしの突き合わせには十分で、HMAC の復元にはならない。`runOne` の catch は `async` なので `crypto.subtle` が使える。
- `cause` を `errorIdentity(error)`（`Name:CODE`）に落とす。`terminal_reason` と同じ射影であり、両者が同じ helper を共有するようにした（ADR-044）。
- テスト側を「除外」から「検知」へ反転する — 失敗ジョブを `send-mail:email:{禁止リストの hmac}:{窓}` という形の `operationKey` で投入し、`lines` を `assertNoForbiddenValue(lines, [operationKey])` に掛ける。

### Consequences

- 良い点: 相関は保たれたまま、bucket の外へ canonical 由来の識別子が出なくなる。
- トレードオフ: 失敗ジョブ1件につき SHA-256 が1回増える。失敗経路だけなので実質無視できる。
- トレードオフ: 運用者がログから直接 `jobs` 行を引けなくなる。相関 ID から逆引きするには DO 側で同じダイジェストを計算する必要がある。運用手順は #38。

---

## ADR-046: 非露出テストは「固定の禁止語」ではなく「その実行が導出した実値」を検査する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー security W-005 への対応）

### Context

AC-3 の検証手段である `routingNonExposure.test.ts` は3点で空振りしていた。(i) 禁止語配列の locator は `dir:g1:b0042` だが、実際の導出は `bucketCount: 256` で0埋めしない `dir:g1:b{0..255}` なので**構造的に一度も一致しない**。(ii) テストが実 `doName` を明示的に haystack から除外していた（`idFromName` の記録と logger の記録が同じ配列だったため）。(iii) 禁止語配列の HMAC は固定文字列で、テストが導出する実 HMAC とは別物。結果として実質検証していたのは「canonical 文字列そのものが出ないこと」だけだった。

### Decision

- `assertNoForbiddenValue(recorded, extra)` に第2引数を足し、**その実行で導出した `canonical` / `hmac` / `doName` の実値**を渡す形にする。固定リストは床であって全体ではない、と JSDoc に明記した。
- **haystack を2本に分ける。** `idFromName` に渡された名前（＝観測可能な出力ではない）と、logger / エラーメッセージ（＝観測可能な出力）を別配列にする。前者は「導出が実際に行われた」ことの positive control として使い、後者だけを検査する。除外は不要になった。
- 禁止語配列の locator を `dir:g1:b42` に直し、**「配列中の locator 形の値が実際の導出形と一致すること」を検査するテストを1本足す**（0埋めや 256 以上の index が紛れ込んだら落ちる）。
- 生 NUL バイトが `forbiddenValues.ts:19` に実在していたので JS エスケープへ直し、あわせて `noRawNul.test.ts` の射程を `valueObject.ts` 1ファイルから `packages/core/src` + `apps/web/app` の TS 全体へ広げた（1ファイル限定のガードだったことが、まさに漏えい検知モジュール自身の `grep` を黙って壊す原因になった）。

### Consequences

- 良い点: 検査が空振りしなくなる。B-002 がテストを素通りした構造的な理由が消えた。
- トレードオフ: `noRawNul.test.ts` が fs を再帰的に走査するので unit スイートに数 ms のコストが乗る。空振り防止のためファイル数の下限も assert している。

---

## ADR-047: `activate` / `promote` は一致行数を読み戻し、`activate` は `callerToken` と `candidateUserId` にも束縛する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー adapter-infra W-001 / security W-006 への対応）

### Context

`mappingOperations.ts` の JSDoc は「7つの書き込みはすべて CAS である」と宣言し、`spec/database/index.md`:622 も「書き込みはすべて CAS で直列化されている」と書く。しかし `run()` は影響行数を返さず、どのメソッドも一致0行を検出していなかった。signup saga の phase 3 で `activateReservation` が0行にヒットしても saga は完走し、予約行は `reserved` のまま残る。`lookupCredential` は `status === 'active'` を要求するので、利用者は**理由が分からないまま永久にログインできない**。

あわせて `activate` だけが `callerToken` を検証せず `operation_id` の一致だけで `user_id` を書いていた。`userData/facade.ts` が自分で理由を書いている — 「束縛は `callerToken` であって `operationId` ではない。設計は `operationId` が未認証のログに出ることを許容しているので、それを知っているだけで書けるなら、ログに出た値が capability になる」。

### Decision

- `activate` / `promote` は `RETURNING 1` で一致行数を読み、0行を `ConflictError` にする（`RESERVATION_NOT_ACTIVATABLE` / `CREDENTIAL_CHANGE_NOT_ADVANCED`）。
- `activate` の束縛を3つにする — `operationId` / `callerToken`（`matchOpaque` の定数時間比較）/ `candidateUserId`（`userId` と一致すること）。`callerToken` は SQL で定数時間比較できないので、`cancel` / `delete` と同じ read-then-CAS 形にする（全体が1つの `transactionSync` の中なので割り込みは無い）。
- **冪等性は明示的に扱う。** `resume-signup` が phase 3 を再実行するので、「同じ operation が既に `active` にした行」は成功として返す（`candidate_user_id` は活性化時に NULL になるため、素朴に CAS すると再実行が conflict になる）。
- `cancel` / `delete` / `reportResult` の「absent is success」は**意図的な設計として維持**し、なぜ `activate` と扱いが違うのかをモジュール JSDoc に書き分けた。

### Consequences

- 良い点: 予約が消えた／別 operation の行だった場合に saga が沈黙して完走することが無くなる。
- 良い点: `operationId` を知るだけで予約行を任意の `userId` へ昇格させる経路が塞がる。到達不能ではあったが、#12 / #45 で経路が増えたときここだけが穴として残る形だった。
- 破壊的変更: `CredentialMappingStore.activate` / facade / DO の RPC / `IdentityDirectoryFacade` / `signupSaga` の呼び出しが5引数になった。`callerToken` は saga が既に持っている値なので追加の採番は無い。

---

## ADR-048: `matchFts` は利用者のキーワードを FTS5 のフレーズリテラルとして囲む

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー adapter-infra W-003 への対応）

### Context

`MATCH` の右辺は文字列リテラルではなく FTS5 のクエリ式である。`"` / `*` / `:` / `^` / `(` `)` や `AND` / `OR` / `NOT` / `NEAR` は演算子として解釈され、閉じていない `"` は構文エラーで例外になる。bind parameter にしても解決しない（bind 後に式としてパースされる）。例外は `translateSqliteError` を通って `SystemError(DatabaseError)` になるので、利用者から見ると「特定の文字を含む検索が 500 になる」形で表面化する。trigram トークナイザは記号もインデックスするため、記号を含む正当な検索語は珍しくない。

### Decision

`'"' + keyword.replaceAll('"', '""') + '"'` でフレーズとして囲む。`tokenizer.integration.test.ts` に演算子8種を含むキーワードが例外にならないことと、素のキーワードの一致が変わらないことを固定した。

### Consequences

- 良い点: 1行で塞がり、trigram の一致性は変わらない。
- トレードオフ: **利用者が FTS5 のクエリ構文を使えなくなる**（`東京 AND 駅` は AND 検索ではなくその文字列そのものの検索になる）。#10 が検索 UI を作るときに、演算子を意図的に露出するなら専用のパーサを置く判断になる。#37 の `probe.ts` はトークナイザ検証の最小の読みなので、ここでは安全側に倒す。

---

## ADR-060: `/settings` は自前の `errorComponent` を持ち、ログアウト導線をストリーミング断片の外へ出す

**日付:** 2026-08-03
**ステータス:** 採用

### Context

レビュー W-002（`review-001-presentation-config.md`）— 認可の権威が DO の epoch ガードへ移った結果、失効セッションは `CurrentUserPanel` のストリーミング**中に** `UnauthorizedError("SESSION_REVOKED")` / `ForbiddenError("ACCOUNT_NOT_ACTIVE")` を投げる。`_app.tsx` の `beforeLoad`（`readAuthStateFn`）は DO を叩かないので `authenticated: true` を返し続け、cookie も残る。アプリ唯一のログアウト導線 `LogoutButton` は panel の JSX の内側にあったので、panel が落ちるとログアウトごと消えていた。

レビューの提案 (a) 「`LogoutButton` を `Suspense` の外へ出す」だけでは**塞がらない**。`@tanstack/react-router@1.170.18` の `Match` は `ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment` であり（`dist/esm/Match.js:78`）、`errorComponent` を持たないルートは境界を作らない。`router.tsx` に `defaultErrorComponent` も無いので、`/settings` の描画時 throw は `_app` の `errorComponent`（`ShellErrorScreen`）まで昇り、**ルートの中身が丸ごと差し替わる** — `SettingsPage` 側へ移したボタンも一緒に消える。

提案 (b)「`guardStreamedRender` で `unauthorized` を検出して cookie を破棄し `/login` へ redirect」は採らない。ストリーミング断片が描画される時点で応答ヘッダは確定済みで、`Set-Cookie` を後から足せない。redirect も同じ理由で信用できない。

### Decision

**2つを組で入れる。**

1. `LogoutButton` を `CurrentUserPanel` から `routes/_app/settings.tsx` の `SettingsScreen` へ移す（`Suspense` の外）。
2. `/settings` に自前の `errorComponent`（`SettingsErrorScreen`）を置き、そこでも `SettingsScreen` を経由させる。

これで panel の失敗はルート内の境界で止まり、エラー表示とログアウトボタンが同じ画面に並ぶ。`logout` ユースケースは DO を一切叩かない（`application/identity/logout.ts` は `UserId.create` のみ）ので、失効セッションでも cookie は確実に破棄できる。

あわせて `SettingsSkeleton` を実 DOM に揃える（レビュー B-001）: ログアウト部はもうストリーミング断片ではないので落とし、行は1行にする（`registerWithPassword` はメールクレデンシャルを1件だけ記録するので、現行の全アカウントで1行）。

### Consequences

- 良い点: 「ログイン状態に見えるのに設定画面がエラーで、自力でセッションを捨てられない」状態が構造的に発生しなくなる。#12 が epoch を進め始める前に穴が塞がった。
- 良い点: スケルトンと実 DOM の行数が一致し、`CLAUDE.md`「Frontend」の *without layout shift* が再び真になる。
- トレードオフ: `/settings` はローダー失敗時も `_app` の `ShellErrorScreen` ではなく自前のエラー面を出すようになった。見た目は同じ構成（`ERROR_TITLE` + メッセージ + `ErrorRetry`）に揃えてあるが、**エラー面が2箇所に増えた**ので、片方だけ直すと割れる。
- 積み残し: 失効セッションの cookie は「ユーザーがログアウトを押すまで」残る。自動破棄には応答ヘッダを握れる経路（awaited server function 側）が要るので、#12 が epoch を進める経路を実装するときに再検討する。
- 複数クレデンシャル（#12）が入ったらスケルトンの行数は再検討が要る。`SettingsSkeleton` の JSDoc にその旨を書いてある。

---

## ADR-061: `redactForClient` は kind ごとに3分類し、`code` だけを通す群を作る

**日付:** 2026-08-03
**ステータス:** 採用

### Context

セキュリティレビュー W-003 — `adapters/cloudflare/jobs/table.ts` の競合エラーが `operationKey` をメッセージへ埋め込み、`conflict` は `redactForClient` の対象外なのでクライアントまで到達しうる。`send-mail` の `operationKey` は HMAC を含む。現状は payload が `operationKey` の関数なので到達不能だが、それは構造ではなく偶然である。

レビューの提案は2つ: (i) メッセージから `operationKey` を落とす（table.ts 側）、(ii) redact を「見せてよい code の allowlist」へ反転させる。本 ADR は presentation 側だけを扱う（table.ts 側は別途）。

(ii) をそのまま採ると壊れる。`errorDisplay.ts` は `business` / `validation` について**コード別の文言が無いとき `error.message` へフォールバックする**設計で、`renderBusinessMessage` / `renderValidationMessage` が `null` を返す経路がまさにそれである。メッセージまで潰すと新しいエラーが黙って空表示になる。

### Decision

**`redactForClient` を kind の網羅 `switch` にし、3分類にする。**

| 群 | kind | 扱い |
|---|---|---|
| 全潰し | `system` / `unknown` | `code: null` + 固定文言（従来どおり） |
| メッセージだけ潰す | `notFound` / `conflict` / `unauthorized` / `forbidden` | `code` は残し、`message` を `"Request failed"` へ |
| 素通し | `business` / `validation` | 従来どおり |

2群目の根拠は `errorDisplay.ts` の実装そのもの — この4 kind は**固定文言を返す枝しか持たず、`message` を一度も読まない**。したがってメッセージを潰しても UI は変わらず、サーバ側の自由文（キー・識別子・内部語彙が混ざりうる）だけが落ちる。網羅 `switch` なので、`SerializedError` の union に kind を足すと**分類を選ぶまでコンパイルが通らない**。

### Consequences

- 良い点: 「たまたま到達不能」だった経路が、到達しても無害になる。table.ts 側の修正と独立に成立する（二重の防御）。
- 良い点: 新しい kind を足す人が redact の判断を強制される。
- トレードオフ: `notFound` / `conflict` / `unauthorized` / `forbidden` のサーバ側メッセージがブラウザの開発者ツールからも読めなくなる。運用側は raw を見る（`errorResponseMiddleware` の logger 経路は redact 前の値を渡している）ので、triage は影響を受けない。
- 検査: `errorResponse.test.ts` に (a) 4 kind の `code` 保持とメッセージ置換、(b) `JOB_PAYLOAD_MISMATCH` 形の `operationKey` がワイヤに出ないこと、の2本を追加した。

---

## ADR-062: request Worker の `.tpl` は `no_bundle` / `[[rules]]` を自分で持ち、redirect 経路と成果物の形を一致させる

**日付:** 2026-08-03
**ステータス:** 採用

### Context

レビュー W-006 — `deploy:request:*` は `-c wrangler.request.<stage>.toml` を明示するので `.wrangler/deploy/config.json` の redirect を外れ、フレームワークが生成する `dist/server/wrangler.json`（`no_bundle: true` / `rules: [{type: "ESModule", globs: ["**/*.js","**/*.mjs"]}]`）を受け取らない。redirect を外れること自体は AC-26 が望んだ挙動だが、その副作用として **wrangler が成果物を再バンドルして出荷する**。

実測（wrangler 4.114.0、`--dry-run`）:

| 経路 | 成果物 |
|---|---|
| redirect（`wrangler deploy`、`-c` なし） | 77 modules / Total Upload 1682.23 KiB |
| `-c wrangler.request.staging.toml`（修正前） | 単一 `index.js` / 1658.87 KiB |

`pnpm start` と起動スモークテストが起動するのは前者の形なので、**検証した形と出荷する形が違う**状態だった。

### Decision

**`wrangler.request.{staging,production}.toml.tpl` に `no_bundle = true` と同じ `[[rules]]` を書く。** 理由をコメントで残す。

TOML の落とし穴を1つ踏んだので記録する: `no_bundle` はトップレベルのキーなので、**`[[durable_objects.bindings]]` より後ろに書くとその表の中のフィールドとして解釈される**（wrangler は `Unexpected fields found in durable_objects.bindings[1] field: "no_bundle"` と警告して黙って無視する）。`main` の直後に置いている。

修正後の実測: `-c wrangler.request.staging.toml --dry-run` が **77 modules / 1682.23 KiB** となり、redirect 経路と一致した。警告ゼロ。

### Consequences

- 良い点: 2経路の成果物が同形になった。`pnpm start` / スモークで起動した形がそのまま出荷される。
- 良い点: `rules` があるので `dist/server/assets/*.js` と `dist/server/rsc/index.js` が ES module として同梱される。動的 import は全て静的文字列リテラルなので、これで解決できる。
- トレードオフ: **フレームワークが生成する設定を `.tpl` が手で複製している。** vite プラグインが将来 `no_bundle` を外したり `rules` を変えたりすると乖離する。`.tpl` のコメントに出所（`dist/server/wrangler.json`）を書いてあるので、ビルド設定を触るときはそこを見比べること。
- state 側には入れない。`vite.config.state.ts` は単一ファイルを出すだけでフレームワーク生成の設定が存在せず、再バンドルしても形が変わらない。

---

## ADR-063: ローカルの `APP_URL` は `pnpm dev` のポート（3000）に合わせる

**日付:** 2026-08-03
**ステータス:** 採用

### Context

レビュー W-005 — `apps/web/wrangler.toml` / `wrangler.state.toml` の `APP_URL` は `http://localhost:8787`（wrangler dev の既定）だが、#37 で **state Worker が `APP_URL` を実際に使うようになった**（`createBindingMailSender(env.MAIL_SENDER, env.APP_URL, …)` がパスワードリセットのリンクを組み立てる）。request 側も `presentation/head.ts` が canonical / og URL をここから作る。README が案内する `pnpm dev` は vite の 3000 番で立つので、リンクが届かないポートを指す。

### Decision

**両ファイルの `APP_URL` を `http://localhost:3000` にする。** 正は `pnpm dev` — README の Quick Start が案内する唯一の開発経路であり、state Worker も `pnpm dev` の auxiliary worker として同じ vite サーバ上で動く。`pnpm start` / `pnpm dev:state`（wrangler の 8787）を使う場合の食い違いは、両 toml のコメントと README「Quick Start」に明記する。

### Consequences

- 良い点: 既定の開発経路でリセットリンクと canonical URL が実際に踏める。
- トレードオフ: `pnpm start` / `pnpm dev:state` 経由では逆に食い違う。どちらかは必ずずれる（wrangler と vite でポートが違うため）ので、頻度の高いほうを正にした。
- `apps/web/__tests__/boot.smoke.test.ts` の `APP_URL: "http://localhost:8787"` は miniflare へ渡すダミーのバインディングで、設定ファイルとは独立。追随不要。

---

## ADR-064: `pnpm dev:state` は state Worker のビルドを内包する

**日付:** 2026-08-03
**ステータス:** 採用

### Context

レビュー W-004 — `wrangler.state.toml` の `main` はビルド成果物（`dist/state/index.js`。AC-19 の設計どおり、vite プラグインの管轄外なので正しい）。しかし `dev:state` は `wrangler dev -c wrangler.state.toml` そのままなので、クリーンな clone では `The entry-point file at "dist/state/index.js" was not found.` で落ちる。README / CLAUDE.md のコマンド一覧にも前提が書かれていなかった。

### Decision

**`@repo/web` の `dev:state` を `vite build --config vite.config.state.ts && wrangler dev -c wrangler.state.toml` にする。** 但し書きを読ませるのではなく、スクリプトを自己完結させる。あわせて README / CLAUDE.md の説明にも「先に `dist/state` をビルドする」と書く。

### Consequences

- 良い点: クリーンな clone で `pnpm dev:state` が単体で動く。`pnpm start` と併用する典型経路でも、state 側だけ古い成果物で動く事故が減る。
- トレードオフ: 起動のたびに state Worker を再ビルドする（数百 ms〜数秒）。`vite.config.state.ts` の `outDir` は `dist/state` で `dist/server` を消さないので、request 側の成果物には影響しない。
- `pnpm dev`（vite の auxiliary worker 経路）はソースエントリを `config: { main: … }` で上書きするので、この変更の影響を受けない。

---

## ADR-070: `User` はクレデンシャル集合を書く遷移を持たない（射影に倒す）

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー domain-usecase B-002 / W-001 / W-002 への対応）

### Context

`User.credentials` は `find()` が `credential_locators` から組み立てる**読み取り射影**である一方、集約は `addCredential` / `removeCredential` を公開していた。`UserSettingsRepository.save` が書くのは `trash_retention_days` / `version` / `updated_at` だけなので、`spec/usecases/identity.md` が指示する手順（`User.addCredential(...)` → `save`）をそのまま実装すると **`version` だけ進んで集合は1ビットも変わらない**。しかも `find()` が返す `credentials` はロケータ由来なので、テストで確認しても「正しく見える」— 実際に効いたのは `CredentialLocatorStore` 側の別の呼び出しである、という壊れ方をする。#12 が `linkSsoCredential` / `unlinkSsoCredential` をこのメソッドの上に建てるので、線を引くのは今である。

関連して2つの非対称も同じ根から出ていた。(a) `initialize` が `credentials` を引数に取りながら唯一の呼び出し（signup phase 2）は常に `[]` を渡す、(b) `spec` は `removeCredential` に `kind: "sso"` 限定を要求しているのに実装は `credentialId` だけで filter し、**テストが逆の挙動（`kind: "email"` の解除成功）を固定していた**。

### Decision

**射影に倒す。**

1. `User` から `addCredential` / `removeCredential` を落とす。集合の増減は `CredentialLocatorStore.record` / `deleteByCredentialId` だけが行う。
2. `User.initialize(params: { id: string }, now)` — **クレデンシャル集合を引数から外す**。phase 2 の時点でロケータ行が無いのは設計上正しく、空集合が唯一の真な値なので、渡せてしまうこと自体が誤りの余地だった。
3. 「最後のログイン手段か」は `User.loginCredentialCount` を述語として残す。`kind: "sso"` 限定と合わせて、検査の所在は解除ユースケース（#12）である。
4. `spec/domains/identity.md`（振る舞い・不変条件・ユースケース概要）/ `spec/usecases/identity.md`（linkSso 手順5-1・unlinkSso 手順2-2/2-3・エラー表）/ `spec/inventory/{domain,usecase}.md` / `spec/testcases/identity/unlinkSsoCredential.md` を実装に合わせる。**規則は1つも変えていない** — 変えたのは「どのモジュールが検査を持つか」だけである。
5. `ports/userSettingsRepository.ts` の JSDoc に「`credentials` は書かれない」を明記する（#12 の実装者が読むのはポートと spec であってアダプターではない）。

不変条件「`credentials` は1件以上・うち1件以上が `usableForLogin`」は**アカウントの不変条件であって、`User` 値の毎瞬の不変条件ではない**と spec 側に書き分けた。強制は入口（予約 → 確定 → `record`）と出口（解除ユースケース）にあり、signup phase 2〜4 の途中で 0 件を通るのは正しい状態である。

### Consequences

- 良い点: 「呼べるが効かない」API が消える。集合の権威が `CredentialLocatorStore` 1つになり、`spec/domains/identity.md`「`User.credentials` はこのストアの射影である」と実装が一致する。逆挙動を固定していたテストも一緒に消えた。
- トレードオフ: 「最後のログイン手段」の検査が集約のメソッド境界から離れ、ユースケースが呼び忘れうる位置へ移る。緩和は3つ — 述語 `loginCredentialCount` を残したこと、spec の手順とエラー表と inventory の3箇所に検査の所在を書いたこと、`entity.test.ts` に述語のテストを残したこと。
- 代替案 (b)「`save` が `credential_locators` の `usable_for_login` / `label` を書き戻す」は採らない。`spec/domains/identity.md`「判定の権威は認証情報側」と衝突し、権威が二重になる。
- **#12 への引き継ぎ:** `unlinkSsoCredential` は (i) `kind: "sso"` (ii) `User.loginCredentialCount` で最後のログイン手段でないこと、の2検査を自分で持つ。`linkSsoCredential` は `User` 側の `save` を発行しない。

---

## ADR-071: DO facade の引数・戻り値の型は `application/di/facades.ts` が持つ

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー domain-usecase B-001 への対応）

### Context

`application/di/facades.ts` が `adapters/cloudflare/{identityDirectory,userData}/facade` から7つの型を `import type` していた。7型は `UserDataFacade` / `IdentityDirectoryFacade` のシグネチャに現れ、`RequestContainer` に載り、`signupSaga` / `loginWithPassword` / `getCurrentUser` / `requestPasswordReset` の型に到達する。つまり**ユースケースがアダプター層の所有する型で書かれていた**。本 PR は同じ形の逆流を ADR-014（`RpcEnvelope`）と ADR-027（`DirectoryLocator`）で2度潰しており、3度目の取りこぼしである。AC-25 (ii) の `grep` が 0 件で通っていたのは `grep -v '/di/'` に救われていたためで、その除外の根拠（「合成ルートだけが具象アダプターを組み立てる正当な場所だから」）は、何も組み立てない契約定義モジュールには当たらない。

`CurrentUserPayload` に至っては `application/identity/view.ts` の `CurrentUserView` と構造が完全に同一の二重定義だった。

### Decision

**契約はインターフェースと同じモジュールが持つ。** `InitializeAccountArgs` / `VerifyLoginArgs` / `RecordCredentialLocatorArgs` / `LookupCredentialArgs` / `LookupCredentialResult` / `ReserveCredentialFacadeArgs` を `application/di/facades.ts` へ移し、`CurrentUserPayload` は廃して `CurrentUserView` に一本化する。アダプター側の facade と DO クラスは**そこから import する**（adapters → application は正方向）。

`lib/rpcPayloads.ts` は採らない。`InitializeAccountArgs` は `LocatorRef` を、facade は `CurrentUserView` を名指しており、どちらも層に属する型なので `lib/`（層の外にあることで全層から依存されてよい場所）に置くと lib → application の依存が生まれる。**ヘキサゴナルの向きで言えば、この2つのインターフェースは DO という外部リソースへの driven port である**から、内側で定義して外側が実装するのがそもそもの形である。

AC-25 (ii) の `grep` は形を変えない（`di/` 除外を「value import に限る」へ狭めることもできない — 両合成ルートは `*FacadeDeps` と `DirectoryLocator` を `import type` で名指しており、それが正当な組み立ての一部である）。代わりに **`packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts`** を置き、「`adapters/` を import してよいのは `di/serverCloudflare.ts` と `di/stateCloudflare.ts` の2ファイルだけ」を機械検査にした。除外がディレクトリではなくファイル名になるので、次に契約モジュールが増えても穴を通れない。

### Consequences

- 良い点: `application → adapters` の import が合成ルート2ファイルに閉じ、それがテストで固定された。`CurrentUserPayload` / `CurrentUserView` の二重定義が消え、`getCurrentUser` の宣言型と実体が一致した。
- トレードオフ: `di/facades.ts` が契約と型定義の両方を持って長くなる。分けるなら `application/rpc/` あたりだが、インターフェースと引数型が離れる不利のほうが大きいと判断した。
- 波及: `apps/web/app/durable-objects/{userData,identityDirectory}.ts` の型参照を `facade.X` から新しい import へ切り替えた（値の参照は `facade.*` のまま）。

---

## ADR-072: 「ログイン手段として成立するか」の述語をドメインに1本化する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー domain-usecase W-003 / W-007 への対応）

### Context

`spec/domains/identity.md`「判定は『クレデンシャルの有無』ではなく『パスワードの検証材料の有無』で行う」という1つの規則が、アダプター層に3回、微妙に違う形で書かれていた — `lookupCredential` の `usable`（status + changeState + nextAttemptAllowedAt）、`requestPasswordReset` の `eligible`（それに `passwordVerifier !== null` と reset throttle）、`sendMail` の `password_verifier === null` のみ。#12 / #18 が条件を1つ足すときに3箇所が揃って直る保証が無い。

同じ場所で `LookupCredentialResult` が非ユニオンだったため、「`passwordVerifier` はあるが `credentialId` は null」という起こりえない組み合わせが型上表現でき、`loginWithPassword` が `credentialId: found.credentialId ?? ""` で塗り潰していた。空文字は `verifyLogin` の中で `CredentialId.create("")` に到達し、**全ての失敗を `ValidationError("INVALID_CREDENTIALS")` に揃える**という同ユースケースの中心的な契約をこの1経路だけが破る。`found.passwordVerifier as PasswordHash` も無検証のブランドキャストだった。

### Decision

1. **`packages/core/src/domain/identity/credentialMappingRules.ts`** に純関数を置く — `isSettled` / `holdsPasswordVerifier`（型述語）/ `isUsableForLogin(mapping, now)` / `isResetRequestAllowed(mapping, now, windowMs)`。3箇所がこれを呼ぶ。**スロットル窓は引数**にして、実値を #18 / #38 に委ねた境界を崩さない。リセット可否をログインの backoff と**別建て**にしたのは意図的で、失敗ログインで他人を回復経路から締め出せてはならないため（その非対称を JSDoc とテストに書いた）。
2. `LookupCredentialResult` を3アームの判別可能ユニオンにする — `password`（検証材料を持つメール行）/ `identity`（SSO 行など、`userId` は引けるがパスワードログインではない）/ `none`（4つの一様応答すべて）。`?? ""` が消え、`loginWithPassword` は `found.outcome !== "password"` で弾く。
3. `as PasswordHash` を `PasswordHash.create` へ置き換える。**壊れた保存値は「そのロケータは何も答えない」として扱う**（`continue`）— 未登録アドレスと同じ経路に落ちるので一様性が保たれる。区別できる失敗を返すと、そのアドレスが存在することを未認証の呼び出し元に教えてしまう。

### Consequences

- 良い点: 規則の所在が1つになり、#12 / #18 が条件を足す先が明確になった。ユニオンで不正状態が型から消え、`loginWithPassword` の一様性を破る唯一の経路がふさがった。
- トレードオフ: `sendMail` は行の狭い射影しか読まないので、`holdsPasswordVerifier` を構造型（`{ passwordVerifier: string | null }`）にして呼んでいる。`CredentialMapping` 全体を組み立てさせるよりは軽いが、規則の適用が「名前で呼ぶ」だけになる箇所が1つある。
- テスト: `credentialMappingRules.test.ts` を新設（4述語 × 境界）。`ssoResolution.integration.test.ts` はユニオンのアームを検査する形へ直した。

---

## ADR-073: 「起こりえない状態」を非空タプル型で消す（`Keyring` / signup の credential 列）

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー domain-usecase W-004 への対応）

### Context

`signupSaga` が2箇所で素の `Error` を投げていた — `"A signup must present at least one credential"` と `activeLocator` の `"The routing keyring produced no active locator"`。素の `Error` は `kind` を持たないので presentation の `unknown` バリアントに落ちて 500 になる。どちらも実行時チェックが不要な形にできる。

### Decision

型で消す。

1. `Keyring.entries` を `readonly [KeyringEntry, ...KeyringEntry[]]`（非空タプル）にする。唯一の構築点 `requireKeyring` が「active はちょうど1つ」を検査済みなので、**型が既に成り立っている事実を言うだけ**であり、新しいキャストは増えない。
2. `DirectoryLocatorResolver.forCanonical` の戻り値を `Promise<readonly [DirectoryLocator, ...DirectoryLocator[]]>` にする。実装は `const [active, ...previous] = keyring.entries` から組むのでキャスト無しでタプルが通る。`RequestContainer.directoryLocator` も同じ形へ。
3. `runSignupSaga` の `credentials` を `readonly [SignupCredentialInput, ...SignupCredentialInput[]]` にする。解決結果もタプルで組み、**`sort` を in-place で呼ぶ**（`Array.prototype.sort(): this` なのでタプル型が保たれる）。`[...resolved].sort()` だと `T[]` に潰れて `ordered[0]` が `T | undefined` に戻るので、ここだけは非破壊にしない。
4. `activeLocator` は全関数になり、2つの `throw` がどちらも消える。

### Consequences

- 良い点: `if (!x) throw` が2つ消え、到達不能な 500 の経路がなくなった。「active 世代が必ず先頭にある」という keyring の契約が型に載った。
- トレードオフ: `forCanonical` を模すテストダブルがタプル型を要求されるようになる（`requestPasswordReset.test.ts` の `LOCATORS` を1件修正）。将来 keyring を空にできる構成を入れるなら `requireKeyring` の検査ごと見直す必要があるが、それは今の設計では起こらない。
- W-004 が同時に挙げていた `requestPasswordReset.ts:35-36` の `if (locator === undefined) return;` は、Wave 1 の adapter-infra W-009 対応（全 locator への無条件ファンアウト）で既に消えていた。

---

## ADR-074: `Email` の domain 部にラベル構文検査を置き、ASCII / 非 ASCII の非対称をなくす

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー domain-usecase W-006 への対応）

### Context

Wave 1 の security W-008 対応で `toAsciiDomain` が `port` / `pathname` / `search` / `hash` を拒否するようになったが、**その関数を通るのは非 ASCII ドメインだけ**である。`EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/` は空白と `@` しか弾かないので、ASCII 経路では `a@example.com/evil` がそのまま canonical になる — 一意性キーであり HMAC 入力であり、リセットメールの宛先でもある値が、届かないアドレスのまま通る。

### Decision

punycode 変換の**後**に `assertDomainSyntax` を掛け、両経路を1つのゲートへ通す。各ラベルが LDH（`[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?`）で、63 文字以下、空ラベル無し、全体 253 文字以下。`xn--` ラベルは LDH なので変換後に掛けるのが正しい順序である（変換前だと国際化ドメインを全部落とす）。

`toAsciiDomain` の port/path/query/hash 拒否は残す。`URL` が `a@例え.com:8080` の `:8080` を `hostname` から切り落とすため、ラベル検査だけでは捕まらない形が非 ASCII 経路にある。

ラベル数の下限（「ドットを1つ以上」）は**置かない**。レビューの提案にも無く、`user@localhost` を落とす副作用が spec の射程を超えるため。

### Consequences

- 良い点: 「構造チェックを通ったが配送不能」なアドレスが登録できなくなった。ASCII と非 ASCII の canonical 化が同じ検査を通る。
- トレードオフ: アンダースコアを含むドメイン（`a@exa_mple.com`）を拒否する。RFC 1035 の LDH には無い文字であり、公開 MX を持つドメインでは実務上使われない。
- テスト: ASCII 経路の 10 ケース（port / path / query / fragment / underscore / 前後ハイフン / 空ラベル / 末尾ドット / 64 文字ラベル）と、通り続けるべき 4 ケースを `valueObject.test.ts` に追加。

---

## ADR-075: ロケータ参照の形はドメインが1つ定義し、application は別名にする

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー domain-usecase W-005 への対応）

### Context

ドメインポート `CredentialMappingStore.reserve` の引数に `locators?: readonly unknown[]` があった。実際に渡るのは `application/execution/jobs.ts` の `LocatorRef`（`credentialId` / `kind` / `hmac` / `generation` / `bucketIndex`）だが、ドメインは application を import できないので `unknown` に潰れていた。`unknown` のまま `reserve` → アダプター → `JSON.stringify` と流れるので、形の誤りはどこでも検出されない。しかもその5フィールドは、同じ PR がドメインに置いた `CredentialLocator` の部分集合そのものである。

### Decision

**形をドメイン側に置き、外側は別名にする。** `domain/identity/ports/credentialLocatorStore.ts` に `CredentialLocatorRef`（5フィールド、**プリミティブのみ**）を置き、`CredentialLocator` をその拡張（`credentialId` を `CredentialId` に絞り、`credentialVersion` / `usableForLogin` / `label` を足す）として定義する。`application/execution/jobs.ts` の `LocatorRef` は `CredentialLocatorRef` の別名にし、`ReserveCredentialArgs.locators` は `readonly CredentialLocatorRef[]` になる。

`CredentialLocatorRef.credentialId` を**ブランドにしない**のは意図的である。この形は値としても旅をする — `operations.target_locators` に入り、コーディネーター予約行に載り、RPC 境界を越えて JSON になる。構造化クローンはブランドを消すので、読み戻した値にブランドを付け直す正直な方法が無い（`application/execution/jobs.ts` 冒頭の「no branded types」はこの理由である）。`CredentialLocator` 側だけが `CredentialId.create` を通した行なのでブランドを持つ。

### Consequences

- 良い点: ドメインポートから `unknown[]` が消え、同じ概念の二重定義も消えた。`reserve` に誤った形を渡すとコンパイルが落ちる。
- トレードオフ: `CredentialLocator` が交差型になり、`credentialId` の型が `string & CredentialId` として表示されうる（値としては `CredentialId` と同一）。継承関係を型で示す価値のほうが大きいと判断した。

---

## ADR-080: signup saga の部分失敗は「補償の観測可能な帰結」で検証する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test B-002 への対応）

### Context

AC-2 は「signup saga の部分失敗・再試行が冪等である」を求めているが、統合テストは happy path しか通していなかった。`resume-signup` のハンドラテストは状態機械だけを見ており、saga 本体（`runSignupSaga`）を一度も走らせていない。

難所は「同じ `operationId` で再投入する」経路をテストからどう作るかである。`operationId` は saga が phase 0 で採番するので、外から同じ値で再実行することはできない — それは仕様であって不足ではない（saga 冒頭の JSDoc「re-send across requests is not a concept this saga has」）。

### Decision

3つの形に分けて検証する。

1. **phase 1b の敗北と補償** — 2クレデンシャル（email + sso）の saga を `runSignupSaga` で直接叩く。先行 saga が同じ SSO identity を取っているので phase 1b が `ConflictError` になり、`cancelAll` がコーディネーター（email）の予約行を巻き戻す。**判定は行数だけでなく「そのアドレスが再び登録できること」**まで見る。`cancelAll` を消すと後続の `registerWithPassword` が `EMAIL_ALREADY_REGISTERED` で落ちる（実測）。
2. **phase 2 の失敗と再試行の収束** — `userDataStubFactory` をラップして `initializeAccount` だけを落とす。補償は走らない（正しい）ので予約は `reserved` のまま残り、新しい試行は新しい operation を採番するので `EMAIL_ALREADY_REGISTERED` に収束し、停止した saga の `candidate_user_id` を書き換えない。これが旧テストの "collapses a concurrent registration race" の等価物でもある。
3. **応答が失われた phase 2 の再送** — ラッパが「本物を呼んでから投げる」形にして、saga が使った `InitializeAccountArgs` を捕まえる。その引数で `initializeAccount` を再送すると成功し、`account` / `operations` / `user_settings` が各1行のままであること、digest を変えると `OPERATION_PAYLOAD_MISMATCH`、`operationId` を変えると `OPERATION_NOT_RECOGNISED` になることを見る。facade の4分岐がそのまま検査対象になる。

RPC スタブのラッパは**スプレッドせず明示的に委譲する**。Workers の RPC スタブはプロキシで own enumerable property を持たないので、`{ ...stub }` は空オブジェクトになり全メソッドが `undefined` になる。

### Consequences

- 良い点: 341 行・5フェーズ・補償付きのオーケストレーションが、happy path 以外で初めて実行される。変異試験4本（`cancelAll` 削除 / `reserve` の重複検出削除 / facade の分岐collapse / `initializeAccount` の外し）がすべて赤になる。
- トレードオフ: (1) は `runSignupSaga` を直接呼ぶので、`registerWithPassword` を経由しない。#37 に SSO を書く経路が無い以上（plan.md のスコープ外）、2クレデンシャルの saga を作る手段は他に無い。

---

## ADR-081: `purge-trash` のチャンク予算を引数にして中断経路をテスト可能にする

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test W-010 への対応）

### Context

AC-10 の「再計算フェーズが空になった起床でだけ削除フェーズへ進む」を担保するのは `if (!recalculated) return { kind: "yield" }` の1行だが、そこへ到達するには出荷時の予算（`chunkRowLimit` 1000 × `maxChunks` 20）を超える 20,000 行のゴミ箱が要る。フィクスチャで作れる量ではない。

### Decision

ハンドラを `createPurgeTrash(budget = CHUNK_BUDGETS["purge-trash"])` のファクトリにし、`export const purgeTrash = createPurgeTrash()` を残す。レジストリと本番経路は無変更で、テストだけが `{ chunkRowLimit: 1, maxChunks: 2 }` を注入する。`migrate-bulk` が `BULK_STEP` でやっている形の踏襲である。

**`maxChunks: 1` は使わない。** 再計算フェーズが常に唯一のチャンクを食い潰すので削除フェーズへ永久に進まず、予算そのものが縮退する。2以上で初めて「再計算が終わってから削除する」順序が観測できる。

**clamp 分岐（`worked === 0 && earliest <= now`）はデータでは到達できない。** `listItemsToPurge` の述語（`status='trashed' AND purge_after <= now`）と `findEarliestPurgeAfter` の述語（`min(purge_after) WHERE status='trashed'`）が同一なので、「due な行があるのに何も削除しなかった」は構成上成立しない（縮小予算でも同じ。実測）。したがって clamp は「2つのクエリが乖離したときにだけ火が点く」防御であり、テストが固定すべきなのは**その warn が出ないこと**である。ハーネスの `lines` を全ケースで `toEqual([])` に使い、死に変数を「不変条件の直接の言明」へ変えた。

### Consequences

- 良い点: `yield` に3ケースで到達し、うち1つ（「何も due でない状態で再計算が未了」）は `yield` ガードを外すと赤になる — 予算切れが `rearm` に化けて残作業が忘れられる退行を検出する。
- トレードオフ: プロダクションコードに1つエクスポートが増えた。既定引数なので呼び出し側の変更はゼロ。
- 記録: clamp が到達不能であることは仕様どおりであり、削除は提案しない（乖離が起きたときの唯一の警報である）。

---

## ADR-082: テスト間クリーンアップは「固定名テスト1本」で観測し、断定を実測へ合わせる

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test W-006 への対応）

### Context

`setup.ts` の JSDoc は「`reset()` と `evictAllDurableObjects()` は射程が違い、どちらか一方では状態が残る」、`docs/test.md` は「順序独立性は完全に `afterEach` に乗っている」と断定していた。実測では**どちらを消しても統合スイートは全緑**である。実際に順序独立性を支えているのは各ファイルのモジュールスコープ `seq` による DO 名のユニーク化だった。

### Decision

**固定 DO 名を使うテストを1本足して `reset()` を実際に荷重させる**（`__tests__/cleanup.integration.test.ts`）。同じ名前・同じ本体の `it` を2本置き、どちらも「到着時に `jobs` が空であること」と「同じ時刻へアラームが張られること」を主張する。2本を**同一にする**のは順序独立にするためで、`--sequence.shuffle.tests` でも成立する。`reset()` を消すと2本目が赤になる（実測）。

**`evictAllDurableObjects()` は現行版では冗長である**ことを実測で確定させた。`reset()` の後、DO はアラームが消えた状態で戻り、次の RPC で再武装する — インスタンスが生き残っていれば `AlarmCache` が一致して `setAlarm` を抑止するはずなので、`reset()` 自身がインスタンスを捨てている。呼び出しは将来版への保険として残すが、**JSDoc と `docs/test.md` の断定は実測どおりに書き換える**。冗長な呼び出しを荷重があると信じることこそ、本物のクリーンアップ漏れを誤診させる原因だからである。

### Consequences

- 良い点: クリーンアップが壊れたら赤になるテストが初めて存在する。`docs/test.md` が「まず名前のユニーク化、次に `afterEach`」という実態を書くようになった。
- トレードオフ: 固定名のテストを1本増やした。並列実行しても vitest は同一ファイル内の `it` を直列に走らせるので競合しない。

---

## ADR-083: `evictAllDurableObjects` を観測するテストは書かない

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test W-006 の残余）

### Context

ADR-082 の測定で、`evictAllDurableObjects()` が観測可能な効果を持たないことが確定した。唯一のインメモリ状態は DO クラスの `protected alarmCache` であり、`reset()` が既にインスタンスごと捨てている。

### Decision

`alarmCache` をテストから覗くための public メソッド／`as unknown as` の型破りは**足さない**。ADR-015 が「プロダクションの DO クラスにテスト専用の public メソッドを生やさない」ために `evictAllDurableObjects()` を選んだのだから、その呼び出しを検証するためにまさにそのメソッドを生やすのは本末転倒である。呼び出しは保険として残し、事実は JSDoc に書く。

### Consequences

- 良い点: プロダクションクラスのテスト用開口部が増えない。
- トレードオフ: `evictAllDurableObjects()` が将来必要になったときに壊れても気づけない。ただし壊れた場合に赤くなるのは `cleanup.integration.test.ts` の2本目（`reset()` が同時に効かなくなる形での退行）なので、完全な盲点ではない。

---

## ADR-084: OCC の「行が無い」と「版が古い」は同一視を仕様として固定する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test W-009 への対応）

### Context

AC-6 は「DO 側の OCC が『行が存在しない』と『版が古い』を取り違えず」と書くが、`conditionalUpdate` は0行を無条件に `ConflictError("OPTIMISTIC_LOCK_FAILURE")` へ倒す。テストは誤帰属（他の文の結果を流用しない）側だけを固定していた。

### Decision

**両者を区別しない**のが実装の意図であり、それを**テストで固定する**。どちらも呼び出し側の `Versioned<T>` がストレージと食い違っていることを意味し、解消手段（読み直して先頭からやり直す）も同じで、区別を publish しても読む者がいない。区別するには追加の `SELECT` が要り、それは1文で完結するという `RETURNING 1` の設計の利点を削る。

AC-6 が禁じているのは**誤帰属**であって区別の欠如ではない、と読む。テストは2つの結果文字列が「呼び出し側が名付けた subject 以外は同一」であることを assert し、`sql/occ.ts` の JSDoc がその理由を持つ。

### Consequences

- 良い点: 後から `NotFoundError` のアームを足すと赤になる。契約が明文化された。
- トレードオフ: 「消えた行を更新した」ことを呼び出し側が知る手段は無いまま。必要になったら仕様変更として扱う。

---

## ADR-085: 起動スモークは成果物の鮮度を mtime で検査する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test W-014 への対応）

### Context

`boot.smoke.test.ts` の `beforeAll` は `existsSync` しか見ないので、「前回のビルド結果が残っている」状態にも緑を返す。#40 の再発をこのスイートで捕まえたい以上、ソースを直した直後の開発者が古いバンドルに対して緑を受け取るのは危険な緑である。

### Decision

レビューの提案 (a)（`test:smoke` を `pnpm build:cf && vitest …` にする）は**採らない**。CI の `build` ジョブが既に `pnpm build:cf` → `pnpm test:smoke` の順で走っており、スクリプト側に押し込むと CI がビルドを2回する。代わりに提案 (b) をテストファイル内で実装する — `apps/web/app` と `packages/core/src` の最新 mtime より `dist/{server,state}/index.js` が新しいことを `beforeAll` で assert する。

除外は2つで、どちらも根拠がある。`__tests__/` 配下は成果物に入らない（このスモークテスト自身を編集しただけで赤くなるのを防ぐ）。`*.gen.ts` はビルド**中**に書き換えられ、2段ビルドの2段目が1段目の出力より後になる。

### Consequences

- 良い点: 古い `dist/` に対して赤になることを実測で確認（`expected 1785715257069 to be greater than 1785716948461`）。ビルド直後は緑。CI のビルド回数は変わらない。
- トレードオフ: ソースを touch しただけでも赤になる。メッセージが `pnpm build:cf` を指示するので誤診しにくい。

---

## ADR-086: DO クラスの RPC エントリ表は反射とゲート実行の2枚で固定する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 レビュー test W-013 への対応）

### Context

`vitest.config.integration.ts` の `include` に `apps/web/app/durable-objects/**` が入っているのに、そこに `*.integration.test.ts` は1本も無かった（.adr/001 の「空の設定を将来の受け皿として温存しない」と逆向き）。同時に AC-16 (i)「ゲートが全 RPC エントリの先頭にあり、例外は2本のみ」は grep 頼りで、`readSchemaVersion` が fail-closed 中でも答えることを確かめるテストも無かった。

### Decision

行を削るのではなく、**そこに DO クラスの統合テストを実際に置く**（`durable-objects/__tests__/rpcEntries.integration.test.ts`）。2枚で固定する。

1. **反射** — `Object.getOwnPropertyNames(Class.prototype)` から内部メソッド8本を引いた集合が「本ファイルが叩くゲート付きエントリ」＋「免除エントリ」と一致すること。新しいエントリを足して分類を決めないと赤になる。
2. **実行** — `_meta.schema_version` を99にした DO に対し、ゲート付きエントリ**全部**を実際に呼び、戻りエンベロープが例外なく `Schema version is newer than this deployment` で `ok: false` になること。1エントリずつではなく1つのオブジェクトとして比較するので、緩んだエントリが差分に名前入りで出る。免除2本は同じ DO で `ok: true` を返す。

### Consequences

- 良い点: AC-16 (i) が grep から機械検査になった。`readSchemaVersion` / `listBucketUserIds` が fail-closed 中に答えることが初めて検証された。変異試験2本（1エントリを `entry()` の外へ出す / 新メソッドを足す）がそれぞれ別のテストを赤にする。
- トレードオフ: `apps/web` 側に `cloudflare:test` の型宣言（`__tests__/env.d.ts`）が要る。`packages/core` 側の同名ファイルと重複するが、両パッケージが独立に typecheck する以上どちらにも要る（core 側の JSDoc が既にその理由を書いている）。
- 内部メソッド名の一覧をテストが持つので、`private` メソッドの改名がこのテストを赤にする。分類を強制する仕組みの代償として受け入れる。

---

## ADR-100: ワイヤから message を落とす kind は必ずサーバログに残す

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2回目レビュー presentation-config W-001 への対応）

### Context

ADR-061 で `redactForClient` を3分類にし、`notFound` / `conflict` / `unauthorized` / `forbidden` の `message` をワイヤから落とした。ところが `errorResponseMiddleware.toClientError` のログ発火条件は `system` / `unknown` のままだったので、この4 kind のサーバ側自由文が**ワイヤからもログからも消えた**。ADR-061 の Consequences「運用側は raw を見るので triage は影響を受けない」と `errorResponse.ts` の JSDoc の断定が、実装と食い違っていた。実害が出るのは `OPTIMISTIC_LOCK_FAILURE` や `JOB_PAYLOAD_MISMATCH` のようにサーバ関数境界まで上がってくる `conflict` で、ジョブランナー側のログがある経路とは違って他に痕跡が残らない。

### Decision

**ログ条件を「kind の列挙」ではなく「redact が message を落とすか」から導く。** `errorResponse.ts` に `redactsMessage(kind)` を置き（`redactForClient` と同じ網羅 `switch`）、middleware は `if (redactsMessage(rawSerialized.kind))` でログする。`business` / `validation` はワイヤに message が残るのでログしない — フォーム却下を運用インシデントにしない、という ADR-061 以前からの線はそのまま。

対称性はテストで固定する: `redactsMessage(kind) === (redactForClient(sample).message !== sample.message)` を8 kind 全部について突き合わせる（`errorResponse.test.ts`）。middleware 側は4 kind それぞれについて「ワイヤは blank、ログには raw が1件」を assert し、`business` は「redact も log もしない」を assert する。

### Consequences

- 良い点: 「ワイヤにもログにも無い」kind が構造的に作れなくなる。新しい kind を足すときは `redactForClient` の網羅 `switch` を通るので、ログ有無の判断も同時に強制される。
- トレードオフ: `notFound` / `unauthorized` はクライアント都合でも起きる（存在しない ID、失効セッション）ので、`error` レベルのログ量が増える。増える分は kind 付きなのでフィルタできる、という前提で受け入れた。量が問題になったら「redact する = ログする」の線ではなく Logger 側のレベル分けで解く。
- ADR-061 の Consequences のうち「運用側は raw を見る」は、本 ADR で**初めて真になった**（当時は偽）。

---

## ADR-101: `pnpm dev` のポートは `strictPort` で 3000 に固定する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2回目レビュー presentation-config W-002 への対応）

### Context

ADR-063 で `APP_URL` を `http://localhost:3000`（`pnpm dev`）に統一したが、vite は既定でポートが塞がっていれば黙って +1 していく。レビュー環境では実際に 3013 で起動し、`og:url` が到達しないポートを指した。ADR-063 が潰したはずの「リセットリンクが届かない」が、設定側は正しいまま実ポート側の理由で再発する形になっていた。README が「3000」と正しく書いてあるぶん気づきにくい。

### Decision

**`vite.config.cloudflare.ts` の `server` に `strictPort: true` を足す。** 3000 が塞がっていれば `Port 3000 is already in use` で起動が失敗する。設定（`APP_URL`）と実ポートが黙って割れる状態が構造的に起きなくなる。

### Consequences

- 良い点: 実測で確認 — 3000 を別プロセスが握った状態では起動が失敗し、空いた状態では 3000 に bind して `og:url` / canonical とも `http://localhost:3000/login` になる。
- トレードオフ: 3000 を使う別プロセス（古い dev サーバの残骸を含む）があると `pnpm dev` が起動しない。黙って別ポートで動くより、落として気づかせるほうが安い — 開発者が対処すべきは「どちらの 3000 が本物か」だから。
- ポート自体を変えたくなったら、`vite.config.cloudflare.ts` と `wrangler.toml` / `wrangler.state.toml` の `APP_URL` と README を同時に直す。3箇所に散る点は ADR-063 のまま変わっていない。

---

## ADR-102: シェル内のエラー面は `ErrorSurface` 1つに寄せ、差は padding だけ prop で受ける

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2回目レビュー presentation-config W-003 への対応）

### Context

ADR-060 で `/settings` に自前の `errorComponent` を置いた結果、エラー面が3つになった（`__root` / `_app` / `/settings`）。うち `_app` と `/settings` は見出し・条件つきメッセージ・`ErrorRetry` の3要素が逐語コピーで、しかも**マージ前の時点で既に割れていた** — `py-2xl` と `pb-2xl`。差が意図的であることはどこにも書かれていなかった。

### Decision

**`components/ui/ErrorSurface` に中身（`<section>` + 見出し + 条件つきメッセージ + `ErrorRetry`）を抽出し、`_app` と `/settings` の両方がそれを描く。** 唯一の差である余白は `className` prop（既定 `py-2xl`、`/settings` は `pb-2xl`）で受け、なぜ違うのかを `ErrorSurface` の JSDoc と `/settings` 側のコメントに書く。`__root` は `AuthSheet` の `title` / `description` 経路で DOM の形が違うので寄せない（`ERROR_TITLE` と `ErrorRetry` の共有はこれまで通り）。

### Consequences

- 良い点: 3箇所あった同じ構造が2箇所（`ErrorSurface` と `__root` の sheet）になり、片方だけ直して割れる余地が消えた。余白差が「実装の差」ではなく「呼び出し側が明示的に渡す値」になった。
- トレードオフ: `ui/` のコンポーネントが1つ増える。`ErrorRetry` に押し込む案もあったが、`ErrorRetry` は `__root` の `fullWidth` 経路でも単体で使われるので、面全体を持たせると2つの役割が同居する。
- `ErrorSurface` は `"use client"` を持たない（`ErrorRetry` が持つ）。エラー面はどちらの経路からもクライアントで描かれるので、境界は `ErrorRetry` の1枚のままでよい。

---

## ADR-103: 統合テストの CI 実行はシャッフル固定（seed は GitHub run id）にする

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2回目レビュー presentation-config W-006 / test W-004 への対応）

### Context

`docs/test.md`:68 と `cleanup.integration.test.ts` の JSDoc がどちらも「スイートは `--sequence.shuffle` で走らせている」と書いていたが、その運用はリポジトリのどこにも無かった（`package.json` / `.github/workflows/ci.yml` に 0 件）。順序独立性を「テストごとに新しい DO 名を作る」に寄せた設計（ADR-082）は妥当だが、それを**破ったときに気づく仕組み**が無い。記述を落として手順に降格させる案と、実際に走らせる案があった。

### Decision

**CI の integration ジョブを `pnpm test:integration` から `pnpm test:integration:shuffle --sequence.seed=${{ github.run_id }}` に置き換える。** 追加のジョブではなく置き換えなので CI 時間は増えない（同じスイートを順序だけ変えて1回走らせる）。seed を run id にしたのは、赤くなった実行を `--sequence.seed=<id>` でローカル再現でき、同じ実行を re-run すれば同じ順序になるから。`test:integration:shuffle` はルート `package.json` のスクリプトとして生やし、`docs/test.md` の Commands 表にも載せる。

### Consequences

- 良い点: 「シャッフルで走らせている」という2箇所の記述が初めて真になった。固定 DO 名を持ち込んだ変更は、遅くとも CI で当たる。
- トレードオフ: 順序依存が入り込んだとき、CI は**確率的に**赤くなる（毎回同じ順序ではない）。再現手段が seed で確保されているので受け入れる。順序依存を隠したまま緑を維持するより、まれに赤いほうが安い。
- `--sequence.shuffle` はファイル順・ファイル内のテスト順の両方をシャッフルする。既存スイートはレビュー側で7シード分の順序独立性が確認済みで、`cleanup` の2ケースは互いに同一に書かれている（順序に依存しない）。
- 順序を固定して切り分けたいときは `pnpm test:integration`（無印）がそのまま残っている。

---

## ADR-090: `sweep-reset-tokens` の投入点はリセット依頼のトランザクションであり、適格性に関わらず無条件に投入する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー adapter-infra B-001 / security W-002 への対応）

### Context

`sweep-reset-tokens` はハンドラも `registry` 登録も `CHUNK_BUDGETS` の枠もあるのに、**`enqueueJob` する経路がリポジトリに1行も無かった。** `spec/database/index.md` の `kind` 全数表は投入点欄を「リセットトークン行を発行するのと同じトランザクション」と名指ししているので、これは仕様との食い違いである。

帰結は2つ。(i) `password_reset_tokens` から行が**一切消えない** — `issue` が消すのは同一 `credential_id` の**未使用**行だけなので、消費済み行（`used_at` 非 NULL・再利用可能な `change_auth_token` を保持）と他クレデンシャルの期限切れ行は誰も消さない。Directory は多数の利用者が相乗りする bucket で 10 GB 上限も共有する。(ii) `prt_expires_idx` の唯一の読み手が居なくなる。

**検出できなかった理由も設計上の教訓である** — `directoryJobs.integration.test.ts` はハンドラを直接呼ぶので、ハンドラが正しくかつ到達不能という状態に緑を返す。対になる `sweep-reservations` は `reserveCredential` に投入点があるため、対称性で見落としやすい。

### Decision

`identityDirectory/facade.ts` の `requestPasswordReset` の `run()` 内で、`send-mail` と並べて無条件に投入する。

```ts
ctx.enqueueJob({
  kind: "sweep-reset-tokens",
  operationKey: "sweep-reset-tokens",   // bucket ごとの定数キー
  payload: {},
  nextRunAt: now + RESET_TOKEN_TTL_MS,
});
```

- **`eligible` 分岐には置かない。** 置くと4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）の行数が割れ、`send-mail` の一様性を守るために払ってきたコストが無意味になる。定数キーなので連打は1行に収束し、収束規則 (1) は `next_run_at` を早める方向にしか動かさないので、無条件投入で余計な起床は増えない。
- **`RESET_TOKEN_TTL_MS` を `resetTokenStore.ts` の private 定数から `lib/jobBudgets.ts` へ移す。** 投入点が同じ数値を必要とし、`lib/` は両者から import できる唯一の置き場である（`facade` → `resetTokenStore` の value import を作らない）。
- 掃除は再武装5種の1つなので、1回 `done` に落ちても次の依頼が収束規則 (3) で復活させ、以後は `min(expires_at)` から自走する。

### Consequences

- 良い点: 消費済み行と期限切れ行が実際に消える。統合テストは**投入経路を通す** — `sendMail.integration.test.ts` の "arms the sweep that eventually clears the rows this path writes" が、依頼 → 配送 → 消費済みへの書き換え → TTL 経過後の起床 → 行0件、を実 job table 越しに通す（ハンドラを直接呼ばない）。
- トレードオフ: **リセット依頼を1度でも受けた bucket は、掃除が空になるまで Alarm を保持する。** 実行可能集合が空でなくなるためで、`deleteAlarm()` は掃除が `done` に落ちてから起きる。仕様どおりの挙動だが、`alarmEntry.integration.test.ts` の「何も無い起床は `deleteAlarm` する」陽性対照は、掃除を先に流してから測る形へ書き換えた。
- トレードオフ: 1依頼あたりの `jobs` 行が 1 → 2 になる。定数キーなので bucket あたり最大1行で、依頼数には比例しない。

---

## ADR-091: リセット依頼の適格判定を sliding から「窓番号の比較」へ変える

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー security W-001 / adapter-infra W-001 への対応）

### Context

`recordResetRequested` は適格・非適格を問わず無条件に `last_reset_requested_at = now` を書き、`isResetRequestAllowed` は `last + window <= now` の sliding 判定だった。したがって**窓より短い間隔で依頼を送り続けるかぎり、その宛先は永久に適格にならない。** 未認証の第三者が victim のアドレスへ 15 分未満の間隔で `request-password-reset` を投げ続けるだけで、victim はパスワードリセットを恒久的に受け取れなくなる。応答は4ケースで一様なので、victim にもオペレーターにも観測できない。

ADR-043 が窓を 60 秒から 15 分へ広げたことで、必要な攻撃レートは 1/15 に下がっている。同じファイルの `reportResult` は**まったく同じ問題を認識して塞いでいる**（「スロットル中の試行はカウンタを進めない — 進めると攻撃者が締め出しを無限に更新できる」）ので、リセット側だけが逆向きだった。

**無条件記録を消す解は採れない。** ADR-043 の不変条件（適格な依頼の窓番号には行がまだ無い）は、`last` が全依頼で前進することに依存している。適格時だけ書く形にすると1周目 B-001 が別の入口から再発する（発行が `t=0.5w` → `[w,1.5w)` の非適格依頼が窓1の行を作る → `t=1.5w` の依頼が適格になり窓1の `done` 行に衝突する）。

### Decision

**判定式だけを窓（floor）判定へ変える。** 記録は無条件のまま残す。

```ts
Math.floor(mapping.lastResetRequestedAt / windowMs) < Math.floor(now / windowMs)
```

- ADR-043 の不変条件は保たれる — ある窓 k の**最初の**依頼は必ず適格（`last` は窓 k 未満）で、そのとき窓 k の `operationKey` の行はまだ存在しない。2回目以降は同じ窓なので非適格。
- 恒久ロックアウトが消える — 誰が叩いても「その窓で最初の1回」は適格なので、登録済みアドレスには窓あたり1通が必ず届く。攻撃者が発行させたトークンのリンクは victim のアドレスへ届くので、victim はそれを使える。
- あわせて `facade` の `if (mapping !== null) recordResetRequested(...)` のガードを外し、**無条件に1文発行する**。未登録アドレスは `WHERE` が0行に当たるだけで、実行される文の数が登録の有無で変わらなくなる。

### Consequences

- 良い点: 未認証の第三者がリセット経路を恒久的に封じる攻撃が成立しなくなる。`credentialMappingRules.test.ts` に境界直前の依頼（`last = 窓末尾 - 1ms`）で次窓が適格になることと、窓の 1/16 間隔で 160 回叩いても適格が窓数と一致することの2本を置いた。
- トレードオフ: 窓境界をまたいだ2依頼が実質同時でも両方発行され、直前のリンクが失効する（sliding では「同じ生きたリンクの再送」になっていた）。ADR-043 が既に窓境界での二重送信を許容しているので、性質としては同種である。
- 引き継ぎ: 依頼レート自体の抑制は #18 のまま。本 ADR が消したのは「恒久」であって「1窓ぶんの遅延」ではない。
- 記録: `recordResetRequested` のコメントを「retry で窓を開けたままにされる」から「**この無条件性が `operationKey` の窓一意性を成立させている**」へ書き直した（2周目 N-002 の指摘どおり、旧文は理由が逆向きに読めた）。

---

## ADR-092: `providerIdempotencyKey` は `operationKey` の SHA-256 とし、生の `operation_key` へのフォールバックを落とす

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー security W-004 への対応）

### Context

`providerIdempotencyKey` は `operationKey` と**同一文字列**だった。`operationKey` は `send-mail:{kind}:{hmac}:{window}` で、`hmac` は canonical アドレスの**全長 HMAC**、すなわち mapping 行の主キーであり、`DIRECTORY_ROUTING_SECRET` の秘匿が「候補アドレスから bucket を計算できない」という性質を支えている値そのものである。それが `Idempotency-Key` ヘッダとしてメール送信 Worker → プロバイダへ出ていく。CLAUDE.md の非同期実行契約 (3) は "derived deterministically from the job's `operationKey`" と書いており、実装は導出ではなく同値だった。ADR-045 が DO のログから消した値が、より外側の境界から出ている。

`sendMail.ts` の `row.provider_idempotency_key ?? row.operation_key` フォールバックは、その抜け道を常設していた。

### Decision

- `providerIdempotencyKey` を **`SHA-256(operationKey)` の hex 64桁**にする。決定性は保たれるので、同一行の再配送は同じキー・新しい窓は新しいキーという性質は変わらない。
- 導出は**非同期**なので DO の RPC エントリで行う（`reserveCredential` の封緘・`mintResetTokenMaterial` と同じ形）。`operationKey` の組み立てと SHA-256 を `identityDirectory/resetRequestKeys.ts` の2関数に置き、**facade とエントリが同じ関数を読む**（2箇所で文字列を組み立てると窓がずれる）。エントリは `this.now()` を1回だけ読んでトランザクションへ渡す。
- **フォールバックを落とす。** `provider_idempotency_key` が NULL の `send-mail` 行は `terminal`（`SEND_MAIL_IDEMPOTENCY_KEY_MISSING`）にする。リセット依頼の投入点が必ず埋めるので、NULL は「別の何かが書いた行」であり、代わりに生キーを送るより拒否するほうが安い。

### Consequences

- 良い点: 全長 HMAC が信頼境界の外に出なくなった。テストは値の一致だけでなく「キーが hmac を含まないこと」「64桁 hex であること」も見る。
- トレードオフ: リセット依頼1回につき WebCrypto 操作が1つ増える（合計3）。無条件に実行されるので4ケースの一様性には影響しない。
- 記録: `mailSender.ts` 側は変更なし（キーは引数で受け取るだけ）。プロバイダ側の実装は #38。

---

## ADR-093: `beginChange` も一致行数を読み戻し、0行は一様な `ConflictError` にする

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー adapter-infra W-002 への対応）

### Context

ADR-047 は `activate` / `promote` に `RETURNING 1` を入れ、`cancel` / `delete` / `reportResult` を「absent is success」として書き分け、モジュール JSDoc に分類節を新設した。しかし **8つの書き込みのうち `beginChange` だけがどちらの列挙にも入らず**、実装も素の `run(...)` だった。`WHERE credential_id = ? AND change_state IS NULL` は実際に外れうる述語（別の変更が飛行中）であり、しかも `beginChange` は「この瞬間から旧材料では検証が通らない」という遷移の起点なので、0行を成功として返すと「変更を開始したつもりで何も起きていない」状態が saga に流れる。1周目 W-001 が `activate` について指摘したのと同一の形である。

### Decision

- `promote` と同形にする（`RETURNING 1` + 0行で `ConflictError`）。
- **コードは `CREDENTIAL_CHANGE_NOT_STARTABLE` にする**（レビューの提案 `CREDENTIAL_CHANGE_ALREADY_IN_FLIGHT` は採らない）。0行は「飛行中の変更がある」と「その credential が無い」の両方を意味するので、`notActivatable()` と同じく**理由で割らない**。割ると bucket の中身を報告することになる。認証済みの呼び出し元で答えを細分化するかは、エントリを持つ #12 の判断に残す。
- モジュール JSDoc の分類節を**8つ全数**へ書き直す（読み戻す3つ / absent is success の4つ / `reserve` の1つ）。今の書き方が「列挙が全数である」と読ませてしまうのが問題の半分だった。ポート側 JSDoc にも `promote` と同じ一文を足す。

### Consequences

- 良い点: 「7つ／8つの書き込みはすべて CAS である」という全数主張が実際に全数になった。`mappingOperations.integration.test.ts` に3本（開始できる / 飛行中は拒否して先行の `pending_verifier` を壊さない / 存在しない credential も同じ答え）。
- 今日は呼び出し元が無い（`begin-credential-change` は #12）ので挙動の変化は無い。#12 はこの契約を引き継ぐ。

---

## ADR-094: `parseResetToken` はルーティング座標をキーリングで範囲検査する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー security W-003 への対応）

### Context

リセットリンクは `{routingGeneration}.{bucketIndex}.{secret}` で、`parseResetToken` はその2数を**範囲検査なしの整数**として返し、JSDoc は「消費エンドポイントが bucket を addressing するための座標」と契約していた。#12 が素直に配線すると、**未認証・クライアント供給の値が `idFromName("dir:g{n}:b{m}")` へ到達する。** AC-4 の保証は「`idFromName` の呼び出し点が合成ルート1箇所に閉じており、外部入力がそこへ到達する経路が無い」であり、リセット消費は本質的にトークンでルーティングせざるを得ないので、この経路だけが唯一の例外になる。範囲検査が無いと `999999999.999999999.<64桁hex>` を投げるだけで任意個の新規 DO を生成でき、各生成で migration と `_meta` 書き込みが走る。

`bucketCount` は世代ごとの値で、**DO 名は bucket の index を運ぶが modulus は運ばない** — キーリングにしか無い。

### Decision

`parseResetToken(token, routing)` にし、`routing` は `readonly { generation, bucketCount }[]`（`DirectoryRoutingKeyring["entries"]` が構造的に満たす）とする。宣言に無い `generation`、または `bucket >= bucketCount` は `null` を返す。`null` は既に「解析不能なトークンは未知のトークンと同じ」に均されているので、応答の一様性は変わらない。

引数を任意にせず**必須**にしたのは、#12 が「後で足す」を選べないようにするためである。

### Consequences

- 良い点: 座標の妥当性が `idFromName` の呼び出し点ではなく**型で強制される**。`resetToken.integration.test.ts` に「未宣言の世代」「`bucketCount` 以上の index」を拒否し、実在する座標は通る（陽性対照2本つき）テストを追加した。
- トレードオフ: 純粋な文字列パーサだった関数がキーリングを要求する。呼び出し元はリクエスト Worker 側（キーリングを持つ側）なので、追加の配布は生じない。
- 引き継ぎ: #12 は消費エントリで `Referrer-Policy: no-referrer` と即時消費を入れること（2周目 security N-012）。

---

## ADR-095: 「最後のログイン手段」のエラーコードは spec 側の名前へ寄せる

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー domain-usecase W-001 への対応）

### Context

#37 は #12 のための引き継ぎ資材として `IdentityErrorCode.LastLoginCredential`（`"IDENTITY_LAST_LOGIN_CREDENTIAL"`）を置いたが、spec 側は `BusinessRuleError(LastCredentialRemoval)` のままで、`LastCredentialRemoval` という識別子はコードのどこにも無い（spec 6箇所 / コード0件）。**throw の実装者は #12 なので、名前が割れていることに気づく機会は #12 の実装時しかなく、そのときに spec とコードのどちらが正かを再判断する羽目になる。**

### Decision

**コード側を spec の名前へ寄せる** — `LastCredentialRemoval: "IDENTITY_LAST_CREDENTIAL_REMOVAL"`。spec 6箇所（`usecases/identity.md` ×2 / `testcases/identity/unlinkSsoCredential.md` / `inventory/test.md` / `manual-tests/account.md` ×2）を触らずに済み、#12 が読むのは spec だからである。`envelope.test.ts` の直書き `"LAST_LOGIN_CREDENTIAL"` も `IdentityErrorCode.LastCredentialRemoval` の参照へ変え、次に名前が動いたときにテストが追随するようにした。

### Consequences

- 良い点: リポジトリ全体で名前が1つになった（`grep` でコード1件・spec 6件がすべて `LastCredentialRemoval`）。
- 影響なし: throw する実装はまだ無いので、挙動は変わらない。

---

## ADR-110: 統合テストは「その DO の起床を駆動する唯一の主体」であることを明示的に確保する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー test B-001 への対応）

### Context

`alarmEntry.integration.test.ts` の "does not delete its alarm when the schema is fail-closed" が、フルスイート実行時に確率的に `expected 2 to be 1` で落ちる（レビュアー実測で22回中2回）。同根の潜在箇所として `resetToken.integration.test.ts` と `identity.integration.test.ts` が挙がっていた。

真因は**プラットフォーム自身の Alarm 配信**である。ゲート付き RPC エントリは必ず `armAfterRpc` で終わり、`clamp` は「すでに due なジョブ」を `setAlarm(now + 1000)` に倒す（`jobs/alarm.ts`）。つまり **RPC の1秒後に workerd が本物の `alarm()` を配信する**。その起床は同じキューの**第二の駆動者**であり、DO 自身の依存（`MAIL_SENDER` 未バインドなので noop sender）でジョブを走らせ、行を settle し、実行可能集合が空になれば `deleteAlarm()` する。

したがって RPC 後に「行数」「受信者」「`deleteAlarm` の回数」を数えるテストは、**経過時間に依存する**。1秒以内に assert が終われば緑、スイートが遅い日は赤になる。順序でも名前でもないので、`docs/test.md` が第一防衛線と呼ぶ名前のユニーク化でも `afterEach` でも防げない。

**再現の確立**: 本機ではフルスイート25回連続で自然再現しなかった（レビュアーの環境より速い）。そこで機構そのものを決定的に再現した。
- `resetToken` / `identity`: RPC 直後に 2000ms 待つ1行を注入 → **どちらも決定的に赤**（`TypeError: … reading 'generation'` と `expected [] to deeply equal [...]`）。
- `alarmEntry`: 数える窓を 2000ms 開いたまま保持し、事前ドレインを外す（＝ RPC が張った `now+1000` が生きている状態で窓を開く）→ **`AssertionError: expected 2 to be 1` を決定的に再現**。レビュー報告と同一のメッセージ。

### Decision

**症状ごとの対症療法ではなく、観測方法の側を直す。** 武装済みの Alarm の配信を抑止する手段は無いので、**武装を残さない**ことを規則にする。

`adapters/cloudflare/__tests__/doHarness.ts` に `disarm(stub)` を置き、**自分でジョブを駆動ないし観測するテストは、実 RPC エントリを叩いた直後に必ずこれを呼ぶ**。3ファイルとも、素の RPC 呼び出しを「RPC + `disarm`」の小さなヘルパ（`request` / `askForResetLink`）に閉じ込め、各ケースが憶えていなくてよい形にした。規則は `docs/test.md`「Timeout / flakiness」に、機構は `disarm` の JSDoc に書いた。

`deleteAlarm` を数える窓については、これに加えて「窓の中でプラットフォームの起床が起こりえないこと」が数値の前提であることを `fireCountingDeletes` の JSDoc に明記した — スパイは `ctx.storage` に掛かるので、第二の起床は「対象が2回呼んだ」と区別できない。

### Consequences

- 良い点: 修正後、注入した 2000ms 遅延を4箇所に置いたままフルスイートが**緑**。逆に `disarm` を no-op へ潰すと同じ遅延で**3本が赤**（陰性対照）。効いているのが再構成ではなく `disarm` であることが確かめられている。
- 良い点: 規則が「RPC を叩いたら disarm」という1行なので、新しい RPC 駆動テストにも機械的に適用できる。
- トレードオフ: `disarm` はインスタンスの `AlarmCache` を触らないので、**武装そのものが主題のスイート**（`jobs/__tests__/alarm.integration.test.ts`）では使えない。JSDoc にその境界を書いた。
- 採らなかった案: 「遅い日でも間に合うようにタイムアウトを伸ばす」「観測前に行を pending へ戻す」はどちらも競合を残したまま確率を下げるだけなので採らない。

## ADR-111: 全ケースで成り立つ不変条件はケースではなくハーネスで assert する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー test W-006 への対応）

### Context

`purgeTrash.integration.test.ts` の `Io.lines` の JSDoc が「ハンドラのログが空であること（＝ clamp が火を噴かないこと）は every case below asserts it」と断定していたが、実際に assert しているのは12ケース中4ケースだった（ADR-081 で死に変数から不変条件の言明へ変えた際に、適用範囲だけが追随しなかった）。

### Decision

`lines` を `Io` から外し、**ハーネスがケース本体の後で `expect(lines).toEqual([])` を実行する**形にした。断定と実態が構造的に一致し、フィクスチャを足しても勝手に外れない。

### Consequences

- 良い点: ハンドラの先頭に無条件の `logger.warn` を1行入れる変異で、**12ケース中11ケースが赤**（残る1本はハンドラを呼ばない enqueue のテスト）。変更前は同じ変異で4本しか赤にならなかった。
- トレードオフ: 「このケースでは clamp が火を噴かない」という説明が個々のケースから消える。代表ケース（"leaves the drive signal strictly in the future after a run"）にはハーネス側を指すコメントを残した。

## ADR-112: 行数を数えるクエリは hmac で絞り、「別の行であること」を witness で固定する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 2周目レビュー test W-003 への対応）

### Context

`identity.integration.test.ts` の「登録済み / 未登録で行数が同じ」テストは、同ファイルの `mappingRowsFor` が hmac で絞っている（「2つのアドレスが同じ bucket に落ちうる」とコメント付き）のに対し、`jobsFor` は `kind = 'send-mail'` だけで絞っていた。2アドレスが同じ bucket を引くと両方の `toHaveLength(1)` が 2 を見る。いまは `seq` が決定的なので当たっていないだけである。

### Decision

`send-mail` の `operation_key` は `send-mail:{kind}:{hmac}:{window}` なので、**hmac の前方一致で絞る**。`LIKE` は使わない — SQLite の `SQLITE_MAX_LIKE_PATTERN_LENGTH` が既定 50 で、64桁 hex を含むパターンは `LIKE or GLOB pattern too complex` で失敗する（実測）。`instr(operation_key, ?) = 1` にした。窓番号は焼き込まない（実行が窓境界をまたいでも壊れないため）。

あわせて **witness を1本置いた** — 2つのクエリが返した `operation_key` が異なること。これが無いと、「同じ1行を2回返すクエリ」でも2つの `toHaveLength(1)` は満たされてしまい、未登録アドレスについて何も主張しないテストになる。

### Consequences

- 良い点: `TEST_DIRECTORY_ROUTING_SECRET` の `bucketCount` を 1 に落として**全アドレスを同一 bucket に衝突させる**変異で、旧クエリは `expected … to have a length of 1 but got 2` で赤、新クエリは緑（実測）。1/256 の潜在バグが実在することと、修正がそれを塞いでいることの両方を確認した。
- トレードオフ: `instr(...) = 1` は `LIKE` より読みづらい。理由をコメントに残した。

## ADR-120: `armAfterRpc` は前倒し専用にする（Alarm 武装の単調性）

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 3周目レビュー adapter-infra W-001 への対応）

### Context

`armAfterRpc` は `persist(ctx, cache, clamp(now, earliest))` を呼び、`persist` は `cache.scheduledAt !== at` なら無条件に `setAlarm(at)` する。DO の Alarm は1本で `setAlarm` は既存を上書きするので、**この経路は武装を未来へ押し出す方向にも動く**。`clamp` が due な行を `now + 1000` に倒すため、`next_run_at <= now` の行がある DO へ1秒より短い間隔で RPC が届き続けるかぎり、武装は毎回「直近の `now` + 1000」へ張り直され、**due な行が一度も配信されない**。Identity Directory は bucket 単位で多数の利用者が相乗りし `lookupCredential` がログイン1回につき1本入るので、到達しうるレートである。止まるのは `send-mail`（唯一の外部 I/O）と `resume-signup`。

一方 `jobs` 行の側（1周目 W-006 / AC-12 (iv)）は既に単調（`nextRunAt` は前倒しにしか動かない）で、**Alarm の側だけが単調でなかった**。

### Decision

`armAfterRpc` にのみ「既に張られている武装より後ろへは動かさない」条件を置く。

```ts
const at = clamp(now, earliest);
if (cache.scheduledAt !== null && cache.scheduledAt <= at) return;
await persist(ctx, cache, at);
```

- **他の3経路には置かない。** `rearmBeforeWork` / `settleAlarm` は `alarm()` の中から権威ある値を書く（settle は正しい時刻へ後ろ倒しする必要があり、実行可能集合が空なら `deleteAlarm()` してキャッシュを `null` にする）。`rearmFailClosed` は fail-closed の固定間隔。**後ろへ倒したい正当な経路はすべて `alarm()` の内側にあり、RPC 経路には無い。**
- 早すぎる武装を残すコストは有界である — その起床は走り、実行可能な行が無ければ `settleAlarm` が正しい時刻を書くか `deleteAlarm()` する。インスタンスが作り直された直後は `cache.scheduledAt === null` なので必ず1回張る（安全側）。
- `AlarmCache` はインスタンス状態なので、この条件は「このインスタンスが張ったと信じている値」に対する単調性であって、ストレージの実値に対するものではない。`settleAlarm` の `deleteAlarm()` だけがキャッシュを `null` にし、それ以外に武装を消す本番経路は無いので、両者は乖離しない。

### Consequences

- 良い点: 高レートの bucket でも「ジョブは高々1回の起床遅れで走る」が成立する。検証は `alarm.integration.test.ts` の "never pushes an existing arm later from an RPC entry"（due な行に対し `now` を進めながら3回叩き、`setAlarm` の書き込みが1回だけであること）。**変異試験で確認** — 条件を外すと同テストのみが赤（`[t+2000] → [t+2000, t+2500, t+2900]`）。
- 良い点: テスト側の偶発的な再武装も減る。`disarm(stub)` は `AlarmCache` を触らないので、以後の RPC は「キャッシュ済みの武装以降」を要求するかぎり `setAlarm` を発行しない。
- トレードオフ: 武装が実際より早いまま残る窓ができ、無駄な起床が1回増えうる。行は失われず自己回復する。
- 引き継ぎ: 起床回数そのものの計測・調整は #38。

## ADR-121: 写像行は `last_reset_requested_at` を `created_at` で作る（NULL で作らない）

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 3周目レビュー adapter-infra W-002 への対応）

### Context

ADR-043 / ADR-091 の不変条件「適格な依頼は必ず未使用の `operationKey` に着地する」は、`last_reset_requested_at` が**全依頼で**前進することに依存している。しかし前進するのは行が存在するときだけで、**行が無い間の依頼は何も残さない**。一方 `send-mail` 行は列挙オラクル対策として写像の有無にかかわらず必ず1行書かれ、`SEND_MAIL_RETENTION_MS`（= 窓）ぶん `done` のまま残る。

したがって同一窓 k の中で「未登録アドレスへの依頼 → そのアドレスで signup（`reserve` が `last_reset_requested_at = NULL` の行を作る）→ 同じアドレスへのリセット依頼」が起きると、`last` が NULL なので適格になり、トークンを発行したうえで `send-mail:{kind}:{H}:{k}` に衝突する。`send-mail` は再武装種ではないので `done` 行は復活せず、**トークンだけが発行されて配送ジョブが立たない**（最大1窓ぶんの未達）。写像行を削除して同じ窓で作り直す経路（`cancel` / `delete`）も同型。

### Decision

`reserve` の `INSERT` で `last_reset_requested_at` に **NULL ではなく `timestamp`（= その行の `created_at`）** を入れる。

- 窓 k で生まれた写像が最初に適格になりうるのは窓 k+1 以降。窓 k+1 に先行する依頼があればその依頼が `last` を k+1 へ進めるので現在の依頼は非適格になり、適格な依頼はやはり必ずその窓の最初の1件である。行の削除→再作成も同様に閉じる。
- `isResetRequestAllowed` の `lastResetRequestedAt === null` 分岐は**残す**（この書き込み以前の既存行のため）。
- 列挙オラクルには触れない — 4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）の行数・`next_run_at`・応答はいずれも適格性を見ずに決まる。非適格ケースの形は `sendMail.integration.test.ts` の `throttled` が既に固定しており、本変更で「登録直後」がその形に1件加わるだけである。

### Consequences

- 良い点: 不変条件が全称に戻り、`lib/jobBudgets.ts` / `identityDirectory/facade.ts` / `mappingOperations.ts` の3箇所の断定と実装が一致する（#12 / #44 がこの宣言を前提に読む）。`jobBudgets.ts` には「写像行の生成をまたいでも成立するのはこの書き込みのため」を明記した。
- 良い点: **変異試験で確認** — バインドを `null` へ戻すと `sendMail.integration.test.ts` の "does not let a mapping born mid-window spend a send-mail key an earlier request already used" が `expected 1 to be +0`（トークンだけが存在する状態）で赤。
- トレードオフ: **登録直後の窓ではリセット依頼が適格にならない**（最大15分）。パスワードを設定した直後の利用者がリセットを必要とする確率と、無言の未達を残す確率を較べての判断である。`identity.integration.test.ts` の "sends the link to the address the signup itself sealed" は主題が配送（ADR-030 → ADR-036 の閉ループ）なので、`signedUpInAnEarlierWindow` で「以前の窓に作られた口座」に均してから測る形にした。
- 記録: `spec/database/index.md` の `last_reset_requested_at` 行に「新しい行は `created_at` で作る」を追記。

## ADR-122: DO クラス経由の武装は「遠未来の武装」で観測する

**日付:** 2026-08-03
**ステータス:** 採用（PR #49 3周目レビュー test W-001 への対応）

### Context

AC-12 (iii)（RPC 経路が `setAlarm` を発行する）は、共有実装（`runRpcEntry`）を `jobs/__tests__/alarm.integration.test.ts` が、User Data クラス経由を `cleanup.integration.test.ts` が押さえていたが、**Identity Directory クラスが共有実装を経由し続けること**だけ観測点が無かった。`entry()` から `runRpcEntry` を外して手書きのゲート + envelope に置き換えても統合スイートは全緑になる（レビュアーの MUT-6、修正前のツリーでも同様＝既存の欠落）。

観測が難しいのは ADR-110 の測定どおり `getAlarm()` が**武装済みで未配送の alarm に `null` を返す**ためで、`alarmEntry.integration.test.ts` はこの理由で `getAlarm()` を使わない方針を明記している。

### Decision

`rpcEntries.integration.test.ts`（DO クラスそのものを主題にする唯一のファイル）に1本足す。**`nextRunAt` を遠未来（`4_000_000_000_000`）にしたジョブを `enqueueJob` で直接入れ、ゲート付き RPC を1本叩き、`getAlarm()` がその時刻を返すことを見る。**

- 遠未来の武装に対しては `getAlarm()` が正しい値を返す（`cleanup.integration.test.ts` の `ARMED_AT` が現にそれを assert している）。同じ定数・同じ手口を使う。
- プラットフォーム配信が起こりえないので `disarm` は不要（ADR-110 の規則は「自分でキューを駆動ないし観測するテスト」に掛かるもので、ここは武装そのものが観測対象である）。
- RPC の**前**にも `getAlarm()` を読み、`null` であることを陰性対照にする。これが無いと「`enqueueJob` が張った」可能性を排除できない。

### Consequences

- 良い点: **変異試験で確認** — `entry()` を「`this.gate()` → `ok(body())` / `err(error)`」の手書き（arming 無し）へ置き換えると本テストが `expected null to be 4000000000000` で赤。レビュアーが検出されないと実測した MUT-6 が検出されるようになった。
- トレードオフ: 「ゲートの全数表」を主題とするファイルに武装の観測が1本混じる。DO クラスを主題にするファイルは他に無く、`cleanup` 側（User Data）との対称性が読み手にとって最も明快だと判断した。

## ADR-130: stub ガードは `instanceof Promise` ではなく `then` の有無で保留中の結果を見分ける

**日付:** 2026-08-03
**ステータス:** 採用（ブラウザ検証 TC-E03 で検出した本 PR 由来の不具合の是正）

### Context

ADR-035 が直した `guardStub`（`application/di/serverCloudflare.ts`）は、呼び出し結果が保留中かどうかを `result instanceof Promise` で判定していた。**workerd の JS RPC はこの判定を通らない。** `Rpc.Result<R>` は `Promise<…> & Provider<R>` の交差型で、実体は pipelining ハンドルを兼ねるカスタム thenable である（`apps/web/worker-configuration.d.ts` の workerd 自身のコメント: "Technically, we use custom thenables here, but they quack like `Promise`s"）。

結果として `.catch(translateStubError)` の枝には一度も入らず、**DO へ到達できない失敗のうち非同期に届くものは全部未翻訳のまま抜けていた**。同期 throw だけが翻訳されるので `stubErrors.ts` は非同期経路に対して事実上デッドコードであり、`CLAUDE.md` の「the calling adapter additionally translates platform failures raised by the stub call itself」は実際には効いていなかった。TC-E03 の実測（state Worker 停止 → ログイン）で `kind: 'unknown'` / `code: null` / `message: 'Worker "fog-state" not found. Make sure it is running locally.'`。

ユーザー可視の実害は無い（`redactForClient` が `unknown` の message を潰し、HTTP は両者 500）。失われていたのは `retryable` の情報と、ログの `kind` による運用トリアージである。

**検出できなかった理由は観測点の位置である。** `adapters/cloudflare/__tests__/stubErrors.test.ts` は `translateStubError` を直接呼ぶだけで、**`guardStub` 自体のテストが1本も無かった**。ADR-035 の学び（「合成ルートを通すハーネスの価値は、ハーネス自身が使われて初めて出る」）と同じ形が、今度は同じ関数の別の行で起きたことになる。

### Decision

**1. 判定を `then` の有無に変える。**

```ts
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
```

`typeof value === "object"` **だけでは足りない**。実測（下記）では `typeof` が `"function"` である — 同じハンドルが pipelining の provider を兼ねるためで、object だけを見る thenable 判定は `instanceof` と同じく全件を取りこぼす。修正の途中で実際にこの形を書き、統合テストが赤で落ちて判明した。

**2. `guardStub` を `async` にはしない。** 全メソッドを Promise 化すると `UserDataFacade.readSchemaVersion(): Promise<RpcEnvelope<number>> | RpcEnvelope<number>` の同期側が消える。この union は DO クラスのインスタンスをそのまま facade として渡すテスト経路のために意図して書かれているので、ガードの都合で潰さない。非 thenable はそのまま返す。

**3. 翻訳は `Promise.resolve(result).catch(...)` で掛ける。** thenable を adopt するので pipelining ハンドルとしての性質は落ちるが、facade は「primitives in / `RpcEnvelope` out」であり pipelining する呼び出しは1件も無い（`grep` 済み）。`result.then(undefined, translateStubError)` なら元のハンドルの `then` を使えるが、戻り値が何であるかは thenable の実装次第で、契約としては `Promise` を返す側が強い。

**4. AC-4 / AC-25 は動かない。** 変更は `serverCloudflare.ts` 内に閉じ、新しい import も `idFromName` / `getByName` の新しい呼び出し点も増えない。`isThenable` はモジュール内の private ヘルパである。

### Consequences

- 良い点: **実測で翻訳が発火する。** 同じ手順（`pnpm start` を 8787 で起動し fog-state の供給元を止め、login サーバー関数を叩く）で、修正前 `kind: 'unknown'` / `code: null` / `message: 'Worker "fog-state" not found…'` → 修正後 `kind: 'system'` / `code: 'DATABASE_ERROR'` / `message: 'Durable Object call failed'`。クライアントへ返る `SerializedError` に `retryable` が乗るようになった（漏洩は修正前後とも無し）。
- 良い点: `ServiceOverloaded` の分岐が非同期経路から到達可能になり、DO 過負荷が retryable として扱われる。
- 良い点: **`guardStub` の観測点ができた。** ADR-131 に置き方を書く。
- トレードオフ: pipelining を使いたくなったら、この行が最初の障害物になる。facade の契約がそれを許していないので現時点では損失ゼロだが、将来 pipelining を導入するなら翻訳の掛け方（`then` の第2引数）ごと引き直すこと。
- 学び: **プラットフォームの型に対する `instanceof` は、この runtime では既定で疑うこと。** RPC の結果・エラー・ハンドルはいずれも workerd 側の実装であり、`Promise` / `Error` のサブクラスである保証は無い。構造で見るか、実物を測るテストを1本置くか、どちらかが要る。

---

## ADR-131: `guardStub` の観測点は「作り物の thenable」と「本物の stub」の2本立てにする

**日付:** 2026-08-03
**ステータス:** 採用（ADR-130 の検証手段）

### Context

ADR-130 の不具合は「workerd の RPC 結果がどんな形か」に対する思い込みだった。**その思い込みは、作り物のフェイクだけでテストしても再現してしまう** — `async` メソッドを持つフェイクは本物の `Promise` を返すので、壊れた `instanceof Promise` 版でも緑になる。現に `di/__tests__/routingNonExposure.test.ts` の `failingNamespace` がその形で、AC-3 の主題（漏洩しないこと）は正しく見ているのに、翻訳が発火しているかどうかは見ていない。

一方、本物の stub だけに頼るのも成り立たない。DO の RPC エントリは失敗を値エンベロープで返すので、**統合環境で「stub 呼び出し自体の非同期失敗」を意図的に起こす手段が無い**（未実装メソッド呼び出しは `@cloudflare/vitest-pool-workers` のラッパ由来、`Symbol.dispose` は同ラッパが露出していない、非 cloneable 引数は workerd が stub 化して通してしまう — 3つとも実測）。

### Decision

**2本立てにする。役割を分ける。**

1. **`application/di/__tests__/stubGuard.test.ts`（unit）** — 翻訳が発火することを見る。フェイクの stub メソッドは `Promise` ではなく**呼び出し可能な thenable**（`Object.assign(() => …, { then })`）を返す。`instanceof Promise` が false かつ `typeof` が `"function"` という2点を、本物の形として最初のケースで陰性対照に固定する。
2. **`application/di/__tests__/stubGuard.integration.test.ts`（integration）** — フェイクが本物と同じ形であることを見る。合成ルート越しの stub と生の stub を並べ、生の側について `instanceof Promise === false` / `[object JsRpcPromise]` / `then` を持つことを**実測**し、ガードを通った側が本物の `Promise` になっていることを見る。

`ns.idFromName` を直接叩くのは ADR-028 の除外（`__tests__/`）の範囲内である。

### Consequences

- 良い点: **変異試験で両方向を確認した。** (i) `instanceof Promise` へ戻すと unit 2本（`translates a failure that arrives as a rejected RPC result` / `carries the overloaded marker through the asynchronous path`）と integration 1本が赤。(ii) thenable 判定を `typeof value === "object"` だけに狭めても同じ3本が赤。復元はスナップショットからの `cp`。
- 良い点: 統合側は本物の workerd の形を測っているので、`@cloudflare/vitest-pool-workers` / workerd の更新で `Rpc.Result` の形が変われば、フェイクが古くなった時点で赤くなる。
- トレードオフ: 統合側は**修正の変異こそ検出するが、翻訳そのものは見ていない**（上記のとおり本物の非同期失敗を作れない）。翻訳の観測は unit 側が持つ、という分担を JSDoc に明記した。
- トレードオフ: リポジトリ初の `biome-ignore`（`lint/suspicious/noThenProperty`）が入った。フェイクが thenable であることは意図そのものなので、規則の但し書き（"unless you intentionally need a thenable object"）に該当する。
