# Identity / Domain / Security Review #006

**PR:** #33
**HEAD:** `29b9ebd2`
**Date:** 2026-07-28
**Round:** 6回目
**Scope:** Identity / Domain / Security

## Summary

- Blockers: 0
- Warnings: 0
- Notes: 1
- Verdict: **RESOLVED**

## Resolution

- B-IDDS6-001:
  - `generation / bucket / opaque_key`を主キーとする一意locator inventoryをV14 migrationで追加し、既存mappingをbackfillした。reserve時にinventoryへ永続し、mapping purge後もrotation対象を保持する。
  - Account Home countはuserごとの最新snapshotへupsertし、checkpointは履歴加算せずsnapshot合計で置換する。Account Homeが非zeroなら`completed_at`を保存しない。
  - production `operatorRotatePage`で同一user・複数locator・page跨ぎを0まで検証し、Directory mapping自体がないorphan reverse locatorでもretirementを拒否するtestを追加した。
- W-IDDS6-001:
  - claim/decrypt後、provider呼出直前に実時計でexpiryを再検証する。期限切れjobはterminal failureとしてciphertext/emailを消去し、providerへ送信しないtestを追加した。
- W-IDDS6-002:
  - `AccountIdentity`をstatus別discriminated unionにし、signup/SSO createではdomain factoryの返却identity/credentialを永続化commandへ渡す。完了後もprimary email、credential、session epochをdomain結果と照合する。
- W-IDDS6-003:
  - Account Home / Identity DirectoryのRPC string decoderをUTF-8 byte上限へ統一し、multi-byte超過testを追加した。

## Resolved Blockers

### B-IDDS6-001 — Account Home旧generation集計がretirementのzero proofにならない [RESOLVED]

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1804-1890`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1014-1032`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:1027-1095`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:890-929`
- 根拠:
  - production operatorが使う`operatorRotatePage`はDirectoryのpageに現れたrowのuserだけを対象に`countActiveGeneration`を呼ぶ。Directory側に対応するactive rowがないAccount Home reverse locatorは集計対象にならないため、全Account Homeのzeroを証明できない。
  - 同一userのold-generation locatorが同一pageに複数ある場合、各rowのrotation直後にgeneration全体の残数を足すため中間残数を重複加算する。pageを跨ぐ場合も同じuserの残数を再加算する。
  - checkpointは`account_home_active_count`を加算更新し、後続pageやconflict解消後の最新snapshotで置換・減算しない。一度非zeroを記録すると、実際にzeroになっても`retirementReady`が永久にfalseになり得る。
  - checkpointの`completed_at`は`accountHomeActive`を見ずにDirectory page完了だけで設定される。completed checkpointは再走査せず保存値を返すため、誤集計を回復できない。
  - 追加testはlegacyの`rotatePreviousGeneration`で単一account・単一old locatorを通すだけで、productionの`operatorRotatePage`、複数locator/page、orphan reverse locator、conflict再開を検証していない。
- 影響:
  - Round 5で要求した「Directory activeとAccount Home active reverseの双方が全bucketで0」というsecret retirement gateを満たさない。
  - stale reverse locatorを見逃してunsafeにretirement可能になる一方、正常完了後もfalse negativeでprevious secretを永久にretireできないケースがある。
- 推奨:
  - rotation対象accountを重複なしでcheckpoint付き台帳へ記録し、accountごとの最新generation countをupsertする。集計値は加算履歴ではなく最新snapshotから算出する。
  - Directory rowに現れないAccount Homeも網羅できるauthoritative inventoryを用意し、全対象走査完了前は`retirementReady`を返さない。
  - production operator経路で複数old locator、page跨ぎ、conflict解消、orphan reverse locatorのtestを追加する。

## Resolved Warnings

### W-IDDS6-001 — reset mailはclaim後のexpiry越えを検査せず送信する [RESOLVED]

- 場所:
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:391-469`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:729-778,868-880`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:1042-1095`
- 根拠:
  - `claimIdentityMail(now, ...)`時点では期限を検査するが、decrypt/parse後、`provider.fetch`直前に現在時刻と`deliveryPayload.expiresAt`を再比較しない。
  - claim時には有効でもdecrypt中に期限を越えたsecretはproviderへ送信される。
  - testはalarm開始前にDB上のexpiryを過去へ変更するケースだけで、claim後・provider呼出前の境界を検証していない。
- 影響:
  - 「reset token expiry前のみ送信」というRound 5のsecurity boundaryにTOCTOUが残る。
- 推奨:
  - provider呼出直前に新しいclock値でexpiryを再検査し、期限切れならleased jobをterminal化してciphertext/emailを消去する。

### W-IDDS6-002 — `AccountIdentity`はpre-commit validatorにはなったが全sagaの永続化権威ではない [RESOLVED]

- 場所:
  - `packages/core/src/domain/identity/accountIdentity.ts:27-105`
  - `packages/core/src/application/identity/coordinator.ts:127-225`
  - `packages/core/src/application/identity/coordinator.ts:451-525`
- 根拠:
  - aggregateはstatusとnullable primary email/credential配列の直積型のままで、pending/deletingを含む不正な組合せを型で表現できる。
  - signupとSSO createは`AccountIdentity.create`を副作用前に呼ぶようになったが、戻り値を破棄し、その後のAccount Home commandを入力値から別途組み立てる。domain結果を永続化commandへ変換していない。
  - change/reset/link/unlink/deleteではdomain結果と永続結果の照合が追加され、Round 5のpost-commit failureは改善しているが、create系では同じauthority guaranteeがない。
- 影響:
  - domain aggregateとadapter commandが将来ずれてもcreate sagaのcontract testで検出できず、「全sagaでAccountIdentityが権威」という設計境界が未完了。
- 推奨:
  - status別のdiscriminated unionへ分け、domain factoryが返したactive identity/credentialをそのままAccount Home commandへ変換する。
  - signup/SSO create完了後もdomain結果とのcredential、primary email、session epoch一致を検証する。

### W-IDDS6-003 — RPCのstring上限がUTF-8 byte上限へ統一されていない [RESOLVED]

- 場所:
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:117-166`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:373-495`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:1012-1051`
- 根拠:
  - locator generation/opaque key、credential ID、generation query、reset secret、provider idempotency keyはJavaScriptの`.length`で制限し、Round 5で導入した`boundedString`のUTF-8 byte上限を使わない。
  - multi-byte inputは宣言上限の最大4倍のbyte列を通過するため、RPCごとに境界の意味が異なる。
- 影響:
  - service-binding境界のsize contractが不均一で、上限±1 testもASCIIだけでは実際のbyte上限を保証しない。
- 推奨:
  - 全RPC decoderを共通UTF-8 byte length helperへ統一し、multi-byte境界testを追加する。

## Notes

### N-IDDS6-001 — 修正後green gate

- Core/Web typecheck: pass
- Identity domain/application unit: 70/70
- Identity integration: 44/44
- Full state integration: 89/89
- Migration integration: 6/6
- Full Biome lint / format: pass
- commit、pushは行っていない。
