# 実装手順 — Issue #27

## 設計

**レイヤーの内側から外側へ**設計する。

### ドメインモデルへの影響

エラークラスに `Symbol.for()` ブランドと `serializedKind` プロパティを追加する。純粋な追加であり、既存のプロパティ・メソッドは変更しない。

- **`CodedError`**（`lib/error.ts`）: `readonly [CODED_ERROR_BRAND] = true as const` を追加。このブランドを`CodedError`直下に置くことで、`ApplicationError`、`BusinessRuleError` など全派生クラスが自動的に継承する。
- **各具象エラークラス**（`ApplicationError` サブクラス）: `readonly serializedKind = "notFound" / "conflict" / "validation" / "unauthorized" / "forbidden" / "system" as const` を追加。これは `toSerialized()` が返す `kind` と一致する。
- **`BusinessRuleError`**（`domain/error.ts`）: `CodedError` 継承なのでブランドは自動継承。`readonly serializedKind = "business" as const` のみ追加。
- **`RehydrationError`**（`domain/error.ts`）: `Error` 直下で `CodedError` ではないため、独自ブランド `REHYDRATION_ERROR_BRAND` を追加。

`AppServerError`（`apps/web/app/presentation/errorResponse.ts`）も同様に `Symbol.for()` ブランドを追加する。こちらは `Error` 直下で `serializedKind` は持たない。

ブランドの設計判断:

- `CodedError` に1つのブランドを置き、`serializedKind` でサブタイプを区別する方式を採る。個々の具象クラスごとにブランドを作るより簡潔で、新たなエラークラス追加時のミス（ブランド追加忘れ）が起きにくい。
- `RehydrationError` と `AppServerError` は `CodedError` 継承でないため、専用ブランドを持つ。

### ユースケース / アプリケーションロジック

ガード関数の実装を変更するのみ。ユースケース・アダプターの呼び出し側は変更不要（シグネチャ同一）。

変更後のガード実装:

```ts
// lib/error.ts — CodedError ブランドの確認ヘルパー（export 不要、各ガード関数内で展開）
// typeof obj === "object" && obj !== null && CODED_ERROR_BRAND in obj

// application/errors.ts
export function isApplicationError(error: unknown): error is ApplicationError {
  return (
    typeof error === "object" && error !== null && CODED_ERROR_BRAND in error
  );
}

export function isConflictError(error: unknown): error is ConflictError {
  return (
    typeof error === "object" &&
    error !== null &&
    CODED_ERROR_BRAND in error &&
    (error as { serializedKind?: string }).serializedKind === "conflict"
  );
}

// domain/error.ts
export function isBusinessRuleError(error: unknown): error is BusinessRuleError<string> {
  return (
    typeof error === "object" &&
    error !== null &&
    CODED_ERROR_BRAND in error &&
    (error as { serializedKind?: string }).serializedKind === "business"
  );
}

export function isRehydrationError(error: unknown): error is RehydrationError {
  return (
    typeof error === "object" && error !== null && REHYDRATION_ERROR_BRAND in error
  );
}
```

- `isApplicationError` はブランドチェックのみ（`ApplicationError` は抽象クラスで固有の `serializedKind` を持たない）
- 具象サブクラスのガードは `CODED_ERROR_BRAND in e` + `serializedKind` の二段構え
- `serializedKind` の型アサーションに `{ serializedKind?: string }` を使うことで、`BusinessRuleError` と `ApplicationError` の区別が不要になる

### アダプター / 永続化 / 外部連携

`helpers.ts:91` の `error instanceof ApplicationError` を `isApplicationError(error)` に変更する。

### UI / プレゼンテーション

- `isAppServerError` の実装: `name` 文字列比較 → `Symbol.for()` ブランドチェックに変更
- `AppServerError` クラスに `readonly [APP_SERVER_ERROR_BRAND] = true as const` を追加
- `isAppServerError` 内の既存の構造チェック（`hasSerializedRemnant` + `asSerializedError`）は維持し、`name` チェックをブランドチェックに置き換える

## 実装ステップ

依存方向の順（内側のレイヤーが先）に並べる。

### 1. `CodedError` に `Symbol.for()` ブランドを追加

- **対象ファイル:** `packages/core/src/lib/error.ts`
- **変更内容:**
   - `export const CODED_ERROR_BRAND: unique symbol = Symbol.for("@repo/core/CodedError") as never;` をトップレベルに追加
  - `CodedError` クラスに `readonly [CODED_ERROR_BRAND] = true as const;` を追加
- **理由:** すべてのエラークラスの基底にブランドを置くことで、`CodedError` を継承する全クラスが自動的にブランドを持つ。`Symbol.for()` は realm のシンボルレジストリ経由なので module graph が分かれても同一のシンボルになる。

### 2. `ApplicationError` サブクラスに `serializedKind` を追加

- **対象ファイル:** `packages/core/src/application/errors.ts`
- **変更内容:**
  - `NotFoundError`: `readonly serializedKind = "notFound" as const;`
  - `ConflictError`: `readonly serializedKind = "conflict" as const;`
  - `ValidationError`: `readonly serializedKind = "validation" as const;`
  - `UnauthorizedError`: `readonly serializedKind = "unauthorized" as const;`
  - `ForbiddenError`: `readonly serializedKind = "forbidden" as const;`
  - `SystemError`: `readonly serializedKind = "system" as const;`
- **理由:** 各エラークラスが自身の `kind` を構造的に保持する。`toSerialized()` の `kind` と一致する値を設定する。

### 3. ドメイン層のエラークラスに `serializedKind` とブランドを追加

- **対象ファイル:** `packages/core/src/domain/error.ts`
- **変更内容:**
  - `BusinessRuleError` クラスに `readonly serializedKind = "business" as const;` を追加
  - `const REHYDRATION_ERROR_BRAND: unique symbol = Symbol.for("@repo/core/RehydrationError") as never;` をトップレベルに追加
  - `RehydrationError` クラスに `readonly [REHYDRATION_ERROR_BRAND] = true as const;` を追加
- **理由:** ガード関数の実装変更に先立ち、クラスが持つべき構造プロパティを追加する。`BusinessRuleError` は `CodedError` 継承なのでブランドは自動継承され、`serializedKind` のみ追加。`RehydrationError` は `CodedError` 非継承のため独自ブランドが必要。

### 4. ガード関数を `instanceof` → 構造判定に変更（application + domain）

- **対象ファイル:** `packages/core/src/application/errors.ts`
- **変更内容:** 7個のガード関数（`isApplicationError`, `isNotFoundError`, `isConflictError`, `isValidationError`, `isUnauthorizedError`, `isForbiddenError`, `isSystemError`）の実装を `CODED_ERROR_BRAND in e` + （必要に応じて）`serializedKind` チェックに変更
  - `isApplicationError`: ブランドチェックのみ
  - 具象サブクラスのガード: ブランドチェック + `serializedKind` マッチ
- **対象ファイル:** `packages/core/src/domain/error.ts`
- **変更内容:**
  - `isBusinessRuleError`: `CODED_ERROR_BRAND in e` + `serializedKind === "business"` に変更
  - `isRehydrationError`: `REHYDRATION_ERROR_BRAND in e` に変更
- **理由:** module graph をまたいでも正しく判定できるようにする。`instanceof` はコンストラクタの参照同一性をチェックするため、別 graph では常に false になる。

### 5. `isAppServerError` を `Symbol.for()` ブランドに変更

- **対象ファイル:** `apps/web/app/presentation/errorResponse.ts`
- **変更内容:**
  - `const APP_SERVER_ERROR_BRAND: unique symbol = Symbol.for("@repo/web/AppServerError") as never;` をトップレベルに追加
  - `AppServerError` クラスに `readonly [APP_SERVER_ERROR_BRAND] = true as const;` を追加
  - `isAppServerError` の `name` チェックを `APP_SERVER_ERROR_BRAND in value` に置き換え
  - 既存の `hasSerializedRemnant` + `asSerializedError` の構造チェックは維持
  - `APP_SERVER_ERROR_NAME` 定数は不要になれば削除（`AppServerError` クラスの `name` プロパティで使われているので削除は任意）
- **理由:** `name` 文字列比較はサブクラスで `name` を上書きしたときに外れる弱さがある（PR #17 R5 の指摘）。`Symbol.for()` ブランドはこの弱さがなく、かつ module graph をまたぐ。

### 6-1. `helpers.ts` の直接 `instanceof` をガード関数呼び出しに置換

- **対象ファイル:** `packages/core/src/adapters/d1/repositories/helpers.ts`
- **変更内容:** `if (error instanceof ApplicationError) throw error;` → `if (isApplicationError(error)) throw error;`
  - 既に `ApplicationError` が import されているので、`isApplicationError` を import に追加するだけ
- **理由:** ガード関数をバイパスした `instanceof` が残っていると、この変更後も `helpers.ts` 内で直接判定が壊れたままになる。`isApplicationError` を使うことで統一的に構造判定される。

### 6-2. Biome GritQL プラグインで `instanceof` 禁止

- **対象ファイル:** `packages/core/lint/no-instanceof-error.grit`（新規）
- **変更内容:** エラー系クラス（`ApplicationError`, `NotFoundError`, `ConflictError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `SystemError`, `BusinessRuleError`, `RehydrationError`, `AppServerError`）に対する `instanceof` 式を検出する GritQL プラグイン。`biome.json` の `plugins` に以下を追加する:
  ```json
  "plugins": ["packages/core/lint/no-instanceof-error.grit"]
  ```
  `.grit` ファイルの内容:
  ```grit
  `$value instanceof $type` where {
    $type <: or {
      `ApplicationError`,
      `NotFoundError`,
      `ConflictError`,
      `ValidationError`,
      `UnauthorizedError`,
      `ForbiddenError`,
      `SystemError`,
      `BusinessRuleError`,
      `RehydrationError`,
      `AppServerError`
    },
    register_diagnostic(
      span = $type,
      message = "Use the guard function (isXxxError) instead of instanceof for error type checks."
    )
  }
  ```
- **理由:** 新たに `instanceof` を使ったコードが書かれるのを機械的に防ぐ。Biome は GritQL ベースのカスタムプラグインをサポートしており、`instanceof XxxError` の形をマッチするルールを書ける。
- **注意:** `instanceof Error`（ビルトイン）は対象外。あくまでプロジェクト定義のエラークラスのみを禁止対象とする。
- **Biome 設定:** `biome.json` の `plugins` にパスを追加

### 6-3. CLAUDE.md に追記

- **対象ファイル:** `CLAUDE.md`
- **変更内容:** エラーハンドリング章の「no `instanceof` enumeration of concrete classes」の理由に「module graph 分割での正しさ」を1文追加。詳細は本 Issue を参照。
- **理由:** 現状の記述は「拡張性」の理由しか書いていない。経緯や実測ログは不要、規約と理由を最低限追記する。

### 7. 品質ゲート

- `pnpm typecheck` を実行しパスさせる
- `pnpm lint:fix && pnpm format` を実行しパスさせる
- `pnpm test` を全パスさせる
- **手動検証**: `pnpm dev` で同時登録レースを再現し、`ConflictError(UNIQUE_VIOLATION)` が `EMAIL_ALREADY_REGISTERED` に読み替えられること、メールアドレス欄直下にエラーが表示されること、ログイン導線が出現することを目視確認
