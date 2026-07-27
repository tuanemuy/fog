# Review 001 — Identity / Security

Status: **CHANGES REQUIRED**

対象: PR #33 (`origin/main...HEAD`)、`.thread/19/plan.md`、identity domain/application、Cloudflare adapter、3 Durable Objects、presentation/session、関連テスト・運用文書。

## Blockers

### B-001 — signup saga が再開可能ではなく、部分失敗で credential が恒久的に詰まる

- 場所:
  - `packages/core/src/application/identity/registerWithPassword.ts:34-55`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:126-210`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:10-115`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:58-67`
- 理由:
  - 公開 usecase はリクエストごとに `userId` と `operationId` を新規生成するため、HTTP 再送は同じ operation を再開しない。
  - 設計と逆に Account Home へ operation を開始する前に Directory reservation を作る。reserve 後の障害では、新しい operation の再送が `CREDENTIAL_ALREADY_REGISTERED` に収束する。
  - Directory activate 後〜Account Home activate 前の障害では active credential と pending account が残る。
  - Account Home の phase は `credential-reserved` と `completed` しか永続化せず、User Data 初期化済み等の fault point を再開できない。
  - `reclaimExpired` は RPC があるだけで Alarm/reconciler から呼ばれず、Directory reconciler 自体が存在しない。
- 提案:
  - transport 境界で stable `operationId` と `userId` を一度だけ確定し、再送でも同じ値を使う。
  - Account Home を saga authority として最初に開始し、各 phase と payload fingerprint を永続化する。
  - 全 fault point を同じ operation から再開する coordinator と Directory reconciler/Alarm を実装し、各 RPC 前後の fault injection test を追加する。

### B-002 — password login が Account Home の active 状態・locator・epoch を確認せず認証を成立させる

- 場所:
  - `packages/core/src/application/identity/loginWithPassword.ts:106-128`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:212-227`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:112-125`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:117-144`
- 理由:
  - login は Directory の active mapping と password hash だけで成功し、Account Home を一度も読むことなく `userId` を返す。
  - B-001 の「Directory activate 済み / Account Home pending」、退会処理中、古い PITR mapping、epoch 不一致でも password が合えば session を発行できる。
  - `getCurrentAccount` の照合は settings 画面でしか呼ばれず、login の認証判定にはならない。
- 提案:
  - Directory lookup 結果に locator generation/account epoch を含め、password verify 後に Account Home の `active`、確定済み credential、epoch を必須照合する。
  - pending/deleting/deleted、mapping/epoch 不一致は session 発行前に同一 public credential error（内部では監査可能な原因）へ収束させる。

### B-003 — session epoch が token に含まれず、認証ガードでも照合されない

- 場所:
  - `packages/core/src/application/ports/sessionCodec.ts:21-24`
  - `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:28-42,93-132`
  - `apps/web/app/presentation/session.ts:36-45`
  - `apps/web/app/presentation/currentUser.ts:17-25`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:146-151`
- 理由:
  - token payload は `{ uid, exp }` のみで、Account Home の `session_epoch` は完全に未使用。
  - deletion/password change/reset/link/unlink が epoch を進めても、既発行 token は最長7日間 `requireUserId()` を通過する。盗難 token や退会前 token の失効契約を満たさない。
- 提案:
  - session に発行時 epoch を署名して含め、すべての protected server execution point の共通 guard で現在の Account Home `active`/epoch と照合する。
  - deletion と将来の credential mutation 後に旧 token が拒否される integration test を追加する。

### B-004 — SSO/reset/link/unlink primitive の application contract が未実装で、同一 email の credential 一意性を保証できない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:57-76,79-97`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:118-245`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:37-76,173-215`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:48-90`
- 理由:
  - `IdentityPrimitivePort.reserveSsoCredential` 等を実装する adapter/coordinator がなく、raw Directory RPC と schema だけがある。
  - SSO reservation は provider/subject locator しか予約せず、`verifiedEmail` の password/email credential を照合しない。同じ email で password account と SSO account を別 userId として作れる。
  - reset は任意の Directory DO に直接 token を保存/consume するだけで、password mapping 更新、Account Home operation、session epoch 更新までの再開可能 saga がない。link/unlink primitive は schema/RPC もない。
- 提案:
  - email credential と provider/subject credential を一つの coordinator operation で予約し、既存 email への自動 link を conflict にする。
  - SSO 初回/同一再送/同時初回/同一 email 競合/provider 境界/rotation と、reset one-time consume 後の mapping+epoch 更新、last credential unlink 拒否を application port 経由の contract test で固定する。

### B-005 — account deletion primitive が冪等でなく、Directory/User Data を削除する coordinator も存在しない

- 場所:
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:146-188`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:54-75`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:137-155`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:132-159`
- 理由:
  - `beginDeletion` に `operationId` がなく、`deleting` 中の再送でも毎回 `operation_epoch` と `session_epoch` を増やすため「同じ operation/epoch から再開」に反する。
  - Account Home が返す locator は `opaqueKey` だけで generation/bucket を欠き、対象 Directory DO へ route できない。
  - tombstone → User Data `deleteAll` → purge → finish を連結・再開する application coordinator がない。現在のテストは Account Home だけを直接 finish し、Directory mapping と User Data が残っていても通る。
- 提案:
  - stable operation ID、固定 epoch、phase、generation/bucket を含む reverse locator を Account Home に永続化する。
  - 全ステップを冪等に進める deletion coordinator/reconciler を実装し、各中断点・再送・古い PITR データ非再活性化を統合テストする。

### B-006 — routing-secret rotation は表と手順だけで、既存 credential を移送できない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityRouting.ts:47-73`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:126-168,212-227`
  - `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:36-45`
  - `docs/runtime_cloudflare.md:111-126`
- 理由:
  - `rotation_checkpoints` table は読み書きする実装がなく、全 bucket scan、active mapping 作成、Account Home reverse locator 更新、競合記録が存在しない。
  - signup は previous mapping を lookup するだけで active locator だけを reserve する。既存 v1-only account は v2/v1 の間だけ読めるが、次の v3/v2 で v1 secret を外すとログイン不能になる。
  - したがって文書の「zero references を確認して previous を外す」を実行する operator path がない。
- 提案:
  - bounded/checkpointed 全 bucket rotation worker/CLI を実装し、Directory と Account Home を再開可能 operation で移送する。
  - active/previous の初回・再送・競合・2回連続 rotation を contract test し、旧 key を外した後も同じ userId を解決できることを確認する。

### B-007 — Account Home PITR 禁止は未接続の関数で、実際の operator restore を止めない

- 場所:
  - `packages/core/src/adapters/cloudflare/pitrPolicy.ts:10-34`
  - `packages/core/src/adapters/cloudflare/__tests__/pitrPolicy.test.ts:4-24`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:78-86`
  - `docs/runtime_cloudflare.md:200-228`
- 理由:
  - `assertRestorableClass` / `assertRestoreAuthority` はテスト以外から一度も呼ばれない。
  - `AccountHomeDurableObject.restore()` は通常 RPC を拒否するだけで、Cloudflare の bookmark/PITR operator API に対する guard ではない。
  - 文書が参照する「operator-only wrapper」はリポジトリに存在せず、誤って Account Home を対象にした restore をコードで阻止できない。
- 提案:
  - restore 対象 class を allowlist し Account Home を API 呼出前に拒否する実 operator CLI/wrapper を追加する。
  - User Data/Directory では restore 前後の Account Home authority/epoch を必須照合し、deleted/deleting/epoch change を fail closed にする command-level contract test を追加する。

### B-008 — versioned RPC envelope が実装されず、identity DO が未検証の raw mutation API を公開している

- 場所:
  - `packages/core/src/application/identity/contracts.ts:3-13`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:20-90`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:17-86`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:27-155`
- 理由:
  - `IDENTITY_RPC_VERSION` は未使用で、RPC は `{ version, operationId?, payload }` envelope ではなく各 method の raw object/primitive を受ける。
  - state-first deploy 時の後方互換判定、未知 version の拒否、mutation operation ID の共通強制ができない。
  - Directory の raw `reserve` は password credential の hash 必須、SSO provider、canonical value の対応関係も runtime validation/schema CHECK で強制しない。
- 提案:
  - versioned primitive request/response envelope と boundary validator を全 RPC に適用し、未知 version・欠損 operation ID・credential kind 不整合を副作用なしで拒否する。
  - rollout compatibility test を旧/新 request contract の双方で追加する。

## Warnings

### W-001 — active/previous lookup の早期 return が rotation 中の account enumeration timing channel になる

- 場所: `packages/core/src/adapters/cloudflare/identityGateway.ts:212-227`
- 理由: locators を逐次 lookup して最初の hit で返すため、previous にある既知 account、active にある account、未知 account で Directory RPC 回数が異なる。password verify/dummy verify が1回でも、反復観測で旧世代 account の存在を推測できる。
- 提案: active/previous lookup を常に全件（可能なら並列）実行し、競合時は fail closed、全失敗経路で同じ authority lookup と1回の verify を行う。

### W-002 — routing HMAC secret の強度と keyring 整合性を検証していない

- 場所: `packages/core/src/application/di/serverCloudflare.ts:40-70`
- 理由: `DIRECTORY_ROUTING_SECRET_ACTIVE` は空でなければ1文字でも通る。previous secret/generation の片方だけが設定された場合は黙って previous を無効化し、同一 generation や同一 secret も拒否しない。弱い key は email locator の辞書攻撃耐性を失わせ、部分設定は account 到達性を壊す。
- 提案: byte-length floorを持つ branded routing secret、active/previous pair の XOR 拒否、generation の非空・相違、active/previous key の相違を config 構築時に fail fast する。

### W-003 — retryable RPC error が retry loop の外で unwrap される

- 場所: `packages/core/src/adapters/cloudflare/identityGateway.ts:84-115,154-209`
- 理由: `unwrap(await retryIdempotent(() => rpc()))` なので `{ ok:false, error:{ kind:"infrastructure", retryable:true } }` は loop 終了後に throw され、一度も retry されない。さらに `unwrap` は元 code/retryable を `NETWORK_ERROR` に畳む。
- 提案: `retryIdempotent(() => rpc().then(unwrap))` の形で envelope error も loop 内に入れ、retryable/code を保持した typed RPC error に変換する。

### W-004 — current-user DTO の security projection が実行時に `sessionEpoch` を漏らす

- 場所:
  - `packages/core/src/application/identity/getCurrentUser.ts:21-33`
  - `packages/core/src/application/identity/contracts.ts:40-48`
  - `packages/core/src/application/identity/view.ts:10-23`
- 理由: 戻り型を `CurrentUserView` と宣言していても、実際には extra property `sessionEpoch` を持つ `CurrentAccount` object をそのまま返す。現在の RSC は必要フィールドだけ描画するが、usecase output を transport に返す将来の経路では「field list is a security boundary」という view の契約を破る。
- 提案: 明示的な object projection を行い、spec の `authMethods` / `displayName` を含む正式 DTO と内部 authority DTO を分離する。

### W-005 — #1 の identity 回帰テストを大幅削除し、置換テストが主要な失敗経路を覆っていない

- 場所:
  - 削除: `packages/core/src/application/identity/__tests__/identity.integration.test.ts`（895行）
  - 置換: `apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:34-76,172-230,296-316`
  - `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts`
- 理由: 新テストは signup/login lookup/current の happy path、単純 duplicate、DO store の直接呼出しが中心。signup 全 fault point、同じ operation 再送、同時 signup、正規化競合、SSO-only/unknown/wrong/malformed の同一 public envelope、actual usecase+session cookie、pending/deleting/deleted login、epoch失効、2世代 rotation、deletion/PITR coordinator を検証していない。実際に B-001〜B-007 を検出できない。
- 提案: 旧 TC 台帳を DO-backed usecase/presentation integration へ移植し、raw store test ではなく公開 port/action を通す。fault injection matrix と回復後の「credential 1件・userId 1件・active authority 1件」を必須 assertion にする。

## Notes

### N-001 — routing ID は HMAC-SHA-256 で opaque 化され、state Worker の dry-run binding に request secrets は出ていない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityRouting.ts:24-44`
  - `apps/web/wrangler.request.toml:6-33`
  - `apps/web/wrangler.state.toml:6-32`
- 理由: raw email/SSO subject を DO name にせず、request/state の secret 境界も構成上分離されている。
- 提案: W-002 の fail-fast validation と rotation 実装を足したうえで、この境界を維持する。

### N-002 — client 向け system/unknown error redaction と cookie 属性は安全側

- 場所:
  - `apps/web/app/presentation/errorResponse.ts:58-95`
  - `apps/web/app/presentation/errorResponseMiddleware.ts:60-95`
  - `apps/web/app/presentation/sessionCookie.ts:29-45`
- 理由: system/unknown の内部 message/code を client へ出さず、session cookie は `HttpOnly`、`SameSite=Lax`、production `Secure`、明示 TTL/expiry を持つ。
- 提案: B-002/B-003 の authority/epoch 検証をこの presentation 境界へ統合する。

## Summary

- Blockers: 8
- Warnings: 5
- Notes: 2

現状は signup の部分失敗、退会/PITR 後の login、session 失効、SSO email 一意性、rotation/deletion/PITR operator path が受け入れ条件を満たさないため承認不可。
