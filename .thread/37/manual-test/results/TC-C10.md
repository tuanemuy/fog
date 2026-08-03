# TC-C10: 全ゲートが通る

**結果**: PASS
**対応する受け入れ基準**: AC-29

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `pnpm install --frozen-lockfile` | exit 0 | exit 0。`Scope: all 4 workspace projects` / `Already up to date` / `Done in 223ms using pnpm v11.1.2`。`ERR_PNPM_OUTDATED_LOCKFILE` なし | PASS |
| 2 | `pnpm typecheck` | exit 0 | exit 0。ルート `tsgo` + `pnpm -r typecheck` の3プロジェクト（`packages/core` = tsgo / `apps/web` = tsgo / `infra/cloudflare/pulumi` = tsc）すべて `Done` | PASS |
| 3 | `pnpm lint` | exit 0 | exit 0。`Checked 220 files in 97ms. No fixes applied. Found 2 infos.` — 2件はいずれも診断ではなく `biome.json` の設定通知（`$schema` が 2.4.15 で CLI が 2.5.5 / `linter.recommended` の deprecation）。**#37 とは無関係の既存事象** | PASS |
| 4 | `pnpm format:check` | exit 0 | exit 0。`Checked 239 files in 38ms. No fixes applied.` | PASS |
| 5 | `pnpm test:unit` | exit 0 | exit 0。**`Test Files 36 passed (36)` / `Tests 525 passed (525)`** / Duration 1.24s | PASS |
| 6 | `pnpm test:integration` | exit 0 | exit 0。**`Test Files 19 passed (19)` / `Tests 187 passed (187)`** / Duration 3.83s | PASS |
| 7 | `pnpm test:integration:shuffle --sequence.seed=1` | exit 0 | exit 0。`Running tests with seed "1"`。19 files / 187 tests passed | PASS |
| 8 | `pnpm test:integration:shuffle --sequence.seed=20260803` | exit 0 | exit 0。`Running tests with seed "20260803"`。19 files / 187 tests passed | PASS |
| 9 | `pnpm test:integration:shuffle --sequence.seed=987654321` | exit 0 | exit 0。`Running tests with seed "987654321"`。19 files / 187 tests passed | PASS |
| 10 | `rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke` | exit 0 | すべて exit 0。`dist/server/index.js 569.16 kB (gzip 120.06)` / `dist/state/index.js 175.62 kB (gzip 52.09)`。smoke は `Test Files 1 passed (1)` / `Tests 2 passed (2)`（詳細は TC-C08） | PASS |
| 11 | `pnpm test:integration:cf` が存在しないこと | `Command not found` | `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "test:integration:cf" not found` / `Did you mean "pnpm test:integration"?` | PASS |

## テスト規模の実測（PR 本文用）

| 種別 | ファイル数 | ケース数 |
|---|---|---|
| unit（`pnpm test:unit`） | 36 | 525 |
| integration（`pnpm test:integration`） | 19 | 187 |
| smoke（`pnpm test:smoke`） | 1 | 2 |
| **合計** | **56** | **714** |

## 順序依存の確認

`--sequence.shuffle` をシード 1 / 20260803 / 987654321 の3通りで回し、いずれも 19 files / 187 tests 緑。ログに `Running tests with seed "<値>"` が出ることでシードが実際に効いていることも確認済み。統合テストに実行順依存は見つからなかった。
