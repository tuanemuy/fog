# TC-E03: state Worker を止めた状態でログインすると 5xx になり内部詳細が漏れない

**結果**: PASS（初回 FAIL → 修正後に再検証して PASS。再検証の実測は末尾の「修正後の再検証」節）
**対応する受け入れ基準**: AC-3（漏洩なし）/ `CLAUDE.md`「the calling adapter additionally translates platform failures raised by the stub call itself」

**初回 FAIL の範囲:** 画面に見える側の期待結果（5xx になる / 内部文言が漏れない / ハングしない）は**3つとも満たしていた**。満たしていなかったのは本ケースの目的に書かれた前半 — **`platform/stubErrors.ts` による `SystemError` への翻訳が発火していない**。`guardStub`（`packages/core/src/application/di/serverCloudflare.ts:98`）に構造的な穴があった。**修正済み（adr.md ADR-130 / ADR-131）。** 以下の「実行ログ」「失敗詳細」は初回実行の記録としてそのまま残す。

## 分離の可否

**分離できた。SKIP せず実施した。** `pnpm dev` は state Worker を auxiliary worker として同一プロセスで起動するため単独では分離できないが、次の構成で完全に分離できる。

1. `pnpm build:cf` 済みの成果物に対して `pnpm start`（8787）を request Worker として起動する
2. fog-state の供給元（`pnpm dev` の auxiliary worker、または `pnpm dev:state`）を止める
3. `pnpm start` のバインディングが `[not connected]` に落ちる

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `pnpm start`（8787）稼働中に `pnpm dev` を停止 | fog-state が落ちる | `⎔ Connection status updated` → `env.USER_DATA (UserDataDurableObject, defined in fog-state) … local [not connected]` / `env.IDENTITY_DIRECTORY … local [not connected]` | PASS |
| 2 | DO を叩かない画面が生きていること | 生きている | `GET /login` → 200 | PASS |
| 3 | DO を叩くリクエスト（signup サーバー関数）を送る | 5xx が返る | `HTTP/1.1 500 Internal Server Error`、body = `{"status":500,"unhandled":true,"message":"HTTPError"}` | PASS |
| 4 | 内部文言が**クライアントへ**漏れないこと | 漏れない | レスポンスボディ全文が上記53バイトのみ。`Durable Object` / `overloaded` / `ctx.abort` / `fog-state` / スタックトレースのいずれも含まれない | PASS |
| 5 | ハングしないこと | しない | `time_total=0.021204s`（21ms）で 500 が返る | PASS |
| 6 | **stub 失敗が `SystemError` へ翻訳されていること** | `kind: 'system'` / `code: DATABASE_ERROR` | **`kind: 'unknown'`, `code: null`, `message: 'Worker "fog-state" not found. Make sure it is running locally.'`** — `translateStubError` を通っていない（**修正後は PASS。** 末尾の再検証節） | **FAIL →（修正後）PASS** |
| 7 | `pnpm dev:state` を起動して復旧 | 復旧する | `… local [connected]` に戻り、同じ signup リクエストが Identity Directory DO へ到達して `kind: 'conflict' / code: 'EMAIL_ALREADY_REGISTERED'` を返す | PASS |

## 失敗詳細

- **失敗ステップ**: 6
- **期待**: DO へ到達できない失敗が `translateStubError` で `SystemError(SystemErrorCode.DatabaseError, "Durable Object call failed")` に翻訳され、`toSerialized()` が `kind: "system"` を返す
- **実際**: 素の `Error` のまま `errorResponseMiddleware` に到達し、`serializeError` が `kind: "unknown"` / `code: null` / `message: 'Worker "fog-state" not found. Make sure it is running locally.'` を作った（`pnpm start` のログに記録）
- **原因**: `packages/core/src/application/di/serverCloudflare.ts:116-118`

  ```ts
  const result = method(...args);
  return result instanceof Promise
    ? result.catch(translateStubError)
    : result;
  ```

  **workerd の JS RPC は本物の `Promise` を返さない。** `apps/web/worker-configuration.d.ts:13023` の workerd 自身のコメントがそう書いている:

  > `// Technically, we use custom thenables here, but they quack like Promise s.`

  `Rpc.Result<R>` は `Promise<…> & Provider<R>` という交差型（pipelining のため）で、実体は `Promise` を継承しないカスタム thenable である。したがって `result instanceof Promise` は **false** に落ち、`.catch(translateStubError)` の枝に入らないまま生の rejection が呼び出し側へ抜ける。同期 throw（`catch` 節）だけが翻訳される。

  最小再現:

  ```js
  const rpcLike = { then(res, rej) { rej(new Error('Worker "fog-state" not found.')); } };
  rpcLike instanceof Promise            // => false
  const guarded = rpcLike instanceof Promise ? rpcLike.catch(translate) : rpcLike;
  await guarded                          // => 'Worker "fog-state" not found.'（翻訳されない）
  ```

- **影響**:
  - `translateStubError` は**非同期の DO 失敗に対して事実上デッドコード**である。単体テスト（`packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts`）は関数を直接呼ぶだけなので、この穴を検知できない。**`guardStub` 自体のテストはリポジトリに1本も無い。**
  - `SystemErrorCode.ServiceOverloaded` への分岐（`overloaded === true`）も同じ理由で発火しない。DO 過負荷が retryable として扱われない。
  - 誤って `ConflictError` になることは無い（`serializeError` は `unknown` へ落とす）ので、`stubErrors.ts` の JSDoc が警戒している「409 を返してしまう」事故は起きていない。
  - **ユーザーに見える範囲では実害が出ていない** — `redactForClient` が `unknown` の `message` を潰すため漏洩は無く、HTTP ステータスも `unknown` / `system` のどちらも 500 になる。表面化するのは (i) `retryable` の情報が失われること、(ii) ログの `kind` がすべて `unknown` に丸まって運用トリアージが効かないこと。

- **修正案**: `instanceof Promise` ではなく thenable 判定にする。

  ```ts
  const result = method(...args);
  return isThenable(result)
    ? Promise.resolve(result).catch(translateStubError)
    : result;
  ```

  ただし `Promise.resolve()` で包むと pipelining ハンドルとしての性質を失うので、pipelining を使っている呼び出しがあれば `result.then(undefined, translateStubError)` の形（元のオブジェクトの `then` を使う）を検討する必要がある。あわせて `guardStub` に対する統合テスト（`@cloudflare/vitest-pool-workers` 上で reject する DO を叩き、`isSystemError` を主張する）を1本足すべきである。

## 代替確認（タスク指示にあったコード側の確認）

`packages/core/src/adapters/cloudflare/platform/stubErrors.ts` 自体は正しい。

- `overloaded === true` → `SystemError(ServiceOverloaded)`
- それ以外 → `SystemError(DatabaseError)`
- `ConflictError` へは決してマップしない

`packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts` は4ケース（overloaded / その他4入力 / ConflictError 不使用 / falsy な `overloaded`）でこれを網羅している。**関数は正しく、呼び出し側の配線が壊れている**というのが本ケースの結論である。

## 環境の復元

`pnpm dev:state` と `pnpm start` を停止し、`pnpm dev`（:3000）を同じコマンドで再起動して PID ファイルを更新した。`.dev.vars` は本ケースでは触っていない。

## 修正後の再検証

**再検証日:** 2026-08-03
**修正:** `packages/core/src/application/di/serverCloudflare.ts` の `guardStub`。`instanceof Promise` を `then` の有無による構造判定（`isThenable`）へ置き換えた。判断の記録は adr.md ADR-130、テストの置き方は ADR-131。

**「修正案」欄からの逸脱が1点ある。** `typeof value === "object"` だけの thenable 判定では**まだ通らない** — 本物の `Rpc.Result` は `typeof` が `"function"` である（pipelining の provider を兼ねるため）。実測は下の表のとおりで、この形を一度書いて統合テストが赤で落ちて判明した。

### 再現手順（初回と同一。コマンドを補記する）

1. `rm -rf apps/web/dist && pnpm build:cf`
2. `apps/web` で `pnpm start`（wrangler dev、8787）を起動する。`pnpm dev`（3000）が fog-state の供給元
3. `pnpm dev` を止める → 8787 のバインディングが `local [not connected]` に落ちる
4. login サーバー関数へ POST する。**ボディは seroval 形式**（TanStack Start のクライアントが `JSON.stringify(toJSONAsync({ data }))` を送る）。ヘッダに `x-tsr-serverFn: true` が要る

   ```sh
   # node -e で payload を作る: JSON.stringify(await toJSONAsync({ data: { email, password } }))
   curl -sS -X POST 'http://localhost:8787/_serverFn/<login-fn-id>' \
     -H 'content-type: application/json' -H 'x-tsr-serverFn: true' \
     --data-binary @payload.json
   ```

   `<login-fn-id>` はビルド成果物から引く（`apps/web/dist/client/assets/index-*.js` の `LoginForm` が import する server fn の id）
5. `pnpm start` のログの `Server function failed { kind, code, message }` を読む

### 実測（同一手順・同一環境での A/B）

| | 修正前（`instanceof Promise` に戻した build） | 修正後 |
|---|---|---|
| ログの `kind` | `unknown` | **`system`** |
| ログの `code` | `null` | **`DATABASE_ERROR`** |
| ログの `message` | `Worker "fog-state" not found. Make sure it is running locally.` | **`Durable Object call failed`**（元のプラットフォームエラーは `cause` に保持） |
| クライアントへ返る `SerializedError` | `{kind:"unknown", code:null, message:"System error"}`（`retryable` が無い） | `{kind:"system", code:null, message:"System error", retryable:false}` |
| HTTP | 500 | 500 |
| 内部文言の漏洩 | 無し | 無し（応答ボディに `fog-state` / `Durable Object` / `overloaded` / `ctx.abort` を含まないことを grep で確認） |
| 応答時間 | 19ms | 5ms |

`code` が `redactForClient` で潰れるのは修正前後とも同じで、**運用側から見える差は `kind` と `retryable`、そしてログの `code`** である。これが本ケースの目的（「翻訳が発火していること」）そのもの。

### workerd の RPC 結果の実測（ADR-130 の根拠）

`@cloudflare/vitest-pool-workers` 上で本物の stub を呼んだ戻り値:

| 観測項目 | 値 |
|---|---|
| `instanceof Promise` | `false` |
| `typeof` | `"function"` |
| `Object.prototype.toString.call(...)` | `[object JsRpcPromise]` |
| `constructor.name` | `RpcPromise` |
| `typeof .then` | `"function"` |

このうち `instanceof Promise` / `toString` / `then` の3項目を `packages/core/src/application/di/__tests__/stubGuard.integration.test.ts` が常設の観測点として持ち、`typeof` は `stubGuard.test.ts` のフェイクが陰性対照として固定する（フェイクを呼び出し可能にしている理由）。

### 復旧確認

`pnpm dev` を再起動 → 8787 のバインディングが `local [connected]` に戻り、同じ login リクエストが Identity Directory DO へ到達して `kind: 'validation' / code: 'INVALID_CREDENTIALS'`（422）を返す。`GET http://localhost:3000/login` も 200。

### 環境の復元（再検証分）

`pnpm start`（8787）を停止し、`pnpm dev`（:3000）を同じコマンドで再起動して PID ファイルを更新した。`.dev.vars` は触っていない。
