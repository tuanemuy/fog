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
