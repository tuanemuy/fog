# TC-C08: ビルド成果物が workerd で起動する（request / state の両方）

**結果**: PASS
**対応する受け入れ基準**: AC-22 / AC-23

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `rm -rf apps/web/dist && pnpm build:cf` | 成功 | exit 0。2段ビルドが両方走る（`vite build --config vite.config.cloudflare.ts` → `… vite.config.state.ts`）。`dist/server/index.js 569.16 kB │ gzip: 120.06 kB`、`dist/state/index.js 175.62 kB │ gzip: 52.09 kB` | PASS |
| 2 | `ls -la apps/web/dist/server/index.js apps/web/dist/state/index.js` | 両方存在 | `569k` / `176k` の2ファイルが存在 | PASS |
| 3 | `pnpm test:smoke` | 緑 | exit 0。`Test Files 1 passed (1)` / `Tests 2 passed (2)`（`apps/web/__tests__/boot.smoke.test.ts` の「answers a request without a global-scope violation」「starts the state Worker, whose Durable Objects it hosts」） | PASS |
| 4 | `apps/web/app/worker/cloudflare/state.ts` の module スコープに `const _probe = crypto.randomUUID();` を注入 → `pnpm build:cf && pnpm test:smoke` | **赤**（global scope 違反を検知） | exit 1。`Test Files 1 failed (1)` / `Tests 2 failed (2)`。両ケースとも `MiniflareCoreError [ERR_RUNTIME_FAILURE]` + `service core:user:state: Uncaught Error: Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope.` | PASS |
| 5 | 注入行を戻して `pnpm build:cf && pnpm test:smoke` | 緑に戻る | `git diff --stat apps/web/app/worker/cloudflare/state.ts` が空。build exit 0、smoke exit 0（`Tests 2 passed (2)`） | PASS |

## 注入試験の詳細（2形態を試した）

testing.md の指示どおりの「未使用の `const`」でも検知されることを確認するため、2形態を試した。

| 形態 | バンドルに残ったか | smoke |
|---|---|---|
| `const _probe = crypto.randomUUID();` + `export { …, _probe }`（tree-shaking を確実に回避） | 残る（`dist/state/index.js:4203 var _probe = crypto.randomUUID();`） | 赤 |
| `const _probe = crypto.randomUUID();`（未使用・未 export。testing.md の字面どおり） | 残る（`randomUUID` の出現1件） | 赤 |

rollup は `crypto.randomUUID()` を副作用のある呼び出しとみなして落とさないので、**testing.md の字面どおりの注入で検知力の検証が成立する**。

## 確認できたこと

- `build:cf` の2段化（steps.md ステップ6）は実際に `dist/state/index.js` を出している。
- スモークテストは「常に緑を返すだけのテスト」ではない — state Worker 側の global scope 違反を確実に赤にする。
- `rm -rf apps/web/dist` からのクリーンビルドが成立する。ローカル `wrangler.toml` の `main` はソースエントリ（`app/server.cloudflare.ts`）のままなので、成果物が無い状態でも `@cloudflare/vite-plugin` は throw しない。

## 補足（AC-23 の残り半分）

スモークが検知するのは workerd が global scope で禁じる3つ（乱数生成・非同期 I/O・タイマー設定）だけである。`Date.now()` は workerd が禁じていないので**この試験では検知されない** — AC-23 のその部分は steps.md ステップ32 の grep 目視が唯一の担保であり、本ケースの射程外。
