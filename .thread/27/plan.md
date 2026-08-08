# 実装計画 — Issue #27: SSR/RSC の module graph 分割で instanceof ベースのエラーガードが機能しない

**Issue:** #27
**作成日:** 2026-08-08
**複雑度:** 中〜大規模
**実装方針:** steps.md

---

## 目的

SSR/RSC の module graph 分割によって `instanceof` ベースのエラーガードが機能しない問題を解消する。全エラーガードを `Symbol.for()` ブランド + 構造タグ（`serializedKind`）による判定に変更し、`isAppServerError` の `name` 文字列比較も同じ原理で置き換える。

## 受け入れ基準

| # | 基準 | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `packages/core/src/application/errors.ts` の7個のガード関数が `instanceof` を使わず構造判定している | Issue本文 (1) | 2,4 |
| AC-2 | `packages/core/src/domain/error.ts` の2個のガード関数が `instanceof` を使わず構造判定している | Issue本文 (1) | 3,4 |
| AC-3 | `isAppServerError` が `name` 文字列比較ではなく `Symbol.for()` ブランドで判定している | Issue本文 (2) | 5 |
| AC-4 | `helpers.ts:91` の `instanceof ApplicationError` が `isApplicationError()` 呼び出しに置き換わっている | 調査 | 6-1 |
| AC-5 | `pnpm typecheck && pnpm lint:fix && pnpm format` がパスする | — | 全 |
| AC-6 | `pnpm test` が全パスする | — | 全 |
| AC-7 | Biome GritQL プラグインでエラー系クラスへの `instanceof` が機械的に検出される（調査結果次第で保留可） | Issue本文 (3) | 6-2 |
| AC-8 | CLAUDE.md のエラーハンドリング規約に module graph の正しさに関する追記がある（1-2文、最低限） | Issue本文 (3) | 6-3 |

## スコープ

### 含まれないもの

- `toSerialized()` の `kind` 文字列を `this.serializedKind` に置き換えるリファクタリング — スコープ外の改善
- `domain/error.ts` の `BusinessRuleError` を `ApplicationError` のサブクラスに変更する階層再編 — Issue外の設計変更
- `RehydrationError` を `CodedError` 継承に変更する — クラス階層の変更はスコープ外
- ユースケース・アダプター内の `instanceof` 呼び出し側の変更 — ガード関数のシグネチャは変わらないため不要

## リスクと注意点

- **テストでは捕まらない**: vitest は単一 module graph なので `instanceof` でもパスする。変更後の構造判定が単一グラフでも正しく動くことをテストで確認するが、二重グラフでの検証は実機（`pnpm dev`）でしかできない
- **`RehydrationError` は `CodedError` 継承ではない**: 独自の `Symbol.for()` ブランドが必要。`BusinessRuleError` は `CodedError` 継承なので共有ブランドでカバーされる
- **`helpers.ts:91` の `instanceof ApplicationError` はガード関数をバイパスしている**: ガード関数の変更だけではここが直らない。明示的に `isApplicationError` 呼び出しに置き換える必要がある
- **`symbol` を値として持つオブジェクトは `JSON.parse(JSON.stringify(obj))` で壊れる**: error オブジェクトがシリアライズ境界をまたぐ経路でこれをやっている箇所があれば問題になる。現状のエラー伝搬（`toSerialized()` による構造化）はこれに依存していないが、新たに `structuredClone` などでブランドが失われないか確認する
- **`isApplicationError` の判定範囲拡大**: 変更後はブランドチェックのみとなるため、`BusinessRuleError`（`CodedError` 継承）にも `true` を返すようになる。これまでは `instanceof ApplicationError` で `false` だった。`helpers.ts:91` の再スロー用途ではむしろ正しい挙動だが、`isApplicationError` と `isBusinessRuleError` を直列に分岐するコードが将来書かれた場合に到達不能分岐を生みうる。`isBusinessRuleError` を先に評価する分岐順の規約が必要
- **`serializedKind` と `toSerialized()` の `kind` の二重管理**: 両者は同一の文字列リテラルを別々に保持しており、不一致はコンパイル時・ユニットテストで検出されない。クラス追加時のレビューで目視確認が必要

## テスト方針

- **既存テストは全パスすべき**: ガード関数のシグネチャが変わらないため
- **ガード関数の単体テスト追加の要否**: 構造判定の正しさ（`isConflictError({}) === false` など）を保証するガード専用のユニットテストを追加する。誤ってブランドや `serializedKind` を削除したときに検知できる。AC-1,2,3 の検証はこのテストに委ねる（実機での二重グラフ検証はテストでは原理的に不可能なため）
  - `isApplicationError`、`isConflictError`、`isBusinessRuleError`、`isRehydrationError`、`isAppServerError` をカバー
  - 陽性ケース（実際のエラーインスタンス）と陰性ケース（`{}`, `null`, `new Error()` など）の両方
  - `isApplicationError` の陽性テストには `BusinessRuleError` インスタンスも含める（`CodedError` 継承のためブランドチェックは陽性になる。判定範囲拡大の意図的な確認として文書化）
- **テストファイルの配置場所**:
  - `packages/core/src/lib/__tests__/error.test.ts`（`CodedError` ブランドの有無）
  - `packages/core/src/application/__tests__/errors.test.ts`（`isApplicationError` ほか）
  - `packages/core/src/domain/__tests__/error.test.ts`（`isBusinessRuleError`, `isRehydrationError`）
  - `apps/web/app/presentation/__tests__/errorResponse.test.ts`（`isAppServerError`）
