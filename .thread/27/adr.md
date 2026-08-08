# ADR — Issue #27: SSR/RSC の module graph 分割で instanceof ベースのエラーガードが機能しない

## ADR-001: エラーブランドに `Symbol.for()` + 基底クラス1つの方式を採用する

### Status
Accepted (2026-08-08)

### Context

SSR/RSC の module graph 分割により、同一ソースファイルが2回インスタンス化され、`instanceof` による同一性判定が常に false になる問題がある。エラーガード関数（`isConflictError` など）を cross-graph で正しく動作させるには、コンストラクタ参照に依存しない判定方法が必要。

以下の2つのアプローチが考えられた:

**A) 具象クラスごとに `Symbol.for()` ブランドを付与する**
- 各エラークラス（`ConflictError`, `NotFoundError`, ...）が専用の `Symbol.for()` ブランドを持つ
- ガード関数は該当ブランドの存在のみをチェック
- メリット: 判定が1ステップ（ブランドチェックのみ）、`serializedKind` プロパティ不要
- デメリット: クラス追加時にブランド追加を忘れやすい、ブランド定数が10個近くになる

**B) 基底クラス（`CodedError`）に1つのブランドを置き、具象クラスは `serializedKind` プロパティで区別する**
- 全 `CodedError` 派生クラスが1つのブランドを継承
- ガード関数はブランドチェック + `serializedKind` 文字列比較の2段階
- メリット: 新規エラークラス追加時に必要なのは `serializedKind` 追加のみ、ブランド追加忘れのリスクがない
- デメリット: 判定が2段階（ただし性能差は無視できる）

### Decision

**B を採用する**。基底クラス `CodedError` に `Symbol.for("@repo/core/CodedError")` ブランドを1つ置き、各具象クラスは `readonly serializedKind` プロパティで自身の種別を宣言する。

理由:
1. **クラス追加のミス耐性**: 新規エラークラスを作るとき、`serializedKind` は `toSerialized()` の `kind` と一致する必要があるため、コピー元からの変更点として自然に意識される。一方、個別ブランド方式では新規ブランド定数の追加が独立したステップになり、忘れやすい。
2. **`CodedError` と `serializedKind` の組み合わせで型安全**: `serializedKind` が "conflict" | "notFound" | ... の union 型になることはないが、ガード関数内で `error.serializedKind === "conflict"` のようにリテラル比較するため、誤字はテストで検出される。
3. **`containerStore.ts` の先行事例と整合**: リポジトリ内で既に `Symbol.for()` をモジュール間共有に使っている。

`RehydrationError` と `AppServerError` は `CodedError` を継承しないため、それぞれ専用の `Symbol.for()` ブランドを持つ。これらは例外であり、`CodedError` 配下のクラス群とは別扱い。

### Consequences

- **良い点**: module graph をまたいでも全ガードが正しく判定できる。新規エラークラス追加時のミスが起きにくい。
- **トレードオフ**: ガード関数が `typeof e === "object" && e !== null && BRAND in e && e.serializedKind === "xxx"` と長くなるが、これはガード関数内に閉じているため呼び出し側には影響しない。

→ `.adr/001` に昇格

---

## ADR-002: `isAppServerError` の判定を `name` 文字列比較から `Symbol.for()` ブランドに変更する

### Status
Accepted (2026-08-08)

### Context

PR #17 で `isAppServerError` を `instanceof` から `name` 文字列比較に変更した（ADR-032）。しかし `name` 文字列比較はサブクラスで `name` を上書きした場合に外れる弱さがあり、PR #17 の R5 レビューで指摘されていた。

### Decision

`name` 文字列比較を `Symbol.for("@repo/web/AppServerError")` ブランドチェックに置き換える。`AppServerError` クラスに `readonly [APP_SERVER_ERROR_BRAND] = true as const` を追加し、`isAppServerError` は `APP_SERVER_ERROR_BRAND in value` で判定する。

### Consequences

- **良い点**: module graph 分割耐性があり、サブクラスで `name` を上書きしても判定が外れない。
- **トレードオフ**: `APP_SERVER_ERROR_NAME` 定数は `AppServerError` クラスの `name` プロパティ用に残るが、判定ロジックからは参照されなくなる。
