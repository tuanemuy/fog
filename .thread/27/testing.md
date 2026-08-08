# 動作確認計画 — Issue #27: SSR/RSC の module graph 分割で instanceof ベースのエラーガードが機能しない

**Issue:** #27
**作成日:** 2026-08-08

---

## 確認環境

### 検証環境の起動

```bash
pnpm dev
```

### デプロイ方法

なし（検証環境のみで確認）

---

## 確認項目

### 1. 既存テストの全パス確認

- **対応する受け入れ基準:** AC-5, AC-6
- **目的:** ガード関数のシグネチャが変わらず、既存の全テストが引き続きパスすることを確認する
- **手順:**
  1. `pnpm test:unit` を実行
  2. `pnpm test:integration` を実行
- **期待結果:** すべてのテストが PASS
- **確認ポイント:** 特に `packages/core/src/application/identity/` 配下のテスト（`isConflictError` による分岐を含む）がパスすること

### 2. 新規ガード関数テストのパス確認

- **対応する受け入れ基準:** AC-1, AC-2, AC-3
- **目的:** ガード関数が構造判定で正しく動作することを確認する（陽性・陰性ケース）
- **手順:**
  1. `pnpm test:unit -- packages/core/src/application/__tests__/errors.test.ts` を実行
  2. `pnpm test:unit -- packages/core/src/domain/__tests__/error.test.ts` を実行
  3. `pnpm test:unit -- apps/web/app/presentation/__tests__/errorResponse.test.ts` を実行
- **期待結果:** すべてのテストが PASS（陰性ケース `{}`, `null`, `new Error()` なども正しく false を返す）
- **確認ポイント:** `isApplicationError` が `BusinessRuleError` に `true` を返すこと

### 3. 同時登録レース時のエラー表示改善確認（実機）

- **対応する受け入れ基準:** AC-1（ガード関数が機能していることの実機確認）
- **目的:** 二重 module graph 環境（SSR/RSC）で `ConflictError(UNIQUE_VIOLATION)` が `EMAIL_ALREADY_REGISTERED` に正しく読み替えられることを確認する
- **手順:**
  1. `pnpm dev` で開発サーバーを起動
  2. 登録ページ（`/signup`）を開く
  3. あるメールアドレスで1回目の登録を正常完了させる
  4. 同じメールアドレスで2回目の登録を試みる
  5. エラー表示を目視確認
- **期待結果:**
  - エラーがメールアドレス欄の直下に表示される
  - 文言: 「このメールアドレスは登録済みです」
  - ログインへの導線（ログインページへのリンク）が表示される
- **確認ポイント:** エラーがフォーム上部のバナーではなく、メールアドレスフィールド直下に表示されること

### 4. 品質ゲート確認

- **対応する受け入れ基準:** AC-5
- **目的:** 型チェック・リント・フォーマットがすべてパスすること
- **手順:**
  1. `pnpm typecheck` を実行
  2. `pnpm lint:fix && pnpm format` を実行
- **期待結果:** すべてエラーなしで完了

---

## エッジケース・異常系

### 1. `isApplicationError` が `BusinessRuleError` にもマッチする

- **目的:** 構造判定への変更後、`isApplicationError` が `BusinessRuleError` にも `true` を返すことを確認する（意図的な挙動変更）
- **手順:**
  1. `pnpm test:unit` で新規追加される `isApplicationError` の陽性テスト（`BusinessRuleError` インスタンス）が PASS することを確認
- **期待結果:** `expect(isApplicationError(new BusinessRuleError("X", "reason"))).toBe(true)` がパス

### 2. 陰性ケースの確認

- **目的:** エラーでないオブジェクト・null・ビルトイン Error がガード関数に false を返すことを確認
- **手順:**
  1. `pnpm test:unit` で各ガード関数の陰性ケースが PASS することを確認
- **期待結果:** `isConflictError({})`, `isConflictError(null)`, `isConflictError(new Error("foo"))` などがすべて false

---

## 既存機能への影響確認

- ユースケース層（`registerWithPassword`, `loginWithPassword` など）: `isConflictError` などガード関数のシグネチャに変更はないため、呼び出し側のコード変更は不要
- アダプター層（`helpers.ts`）: `instanceof ApplicationError` → `isApplicationError()` への置換後も、`ApplicationError` サブクラスの再スローという元の動作を維持する（ブランドチェックにより `BusinessRuleError` も含まれるが、`helpers.ts` の再スロー用途ではスーパーセットで安全）
- `isAppServerError`: プレゼンテーション層のエラーハンドリングで使われている。`name` 文字列比較 → `Symbol.for()` ブランドへの変更で、サブクラスでの `name` 上書きに対して頑健になる
