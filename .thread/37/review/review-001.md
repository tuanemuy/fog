# PR Review #001 — D1 + Outbox から SQLite-backed Durable Objects + Alarm へ移行する

**PR:** #49
**Date:** 2026-08-03
**Round:** 1回目

## Summary

- Blockers: 12
- Warnings: 47
- Notes: 52
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Domain / Use Case: review-001-domain-usecase.md（B: 2 / W: 8）
- Adapter / Infrastructure: review-001-adapter-infra.md（B: 3 / W: 9）
- Security: review-001-security.md（B: 2 / W: 8）
- Test: review-001-test.md（B: 4 / W: 16）
- Presentation / Config・Build・Docs: review-001-presentation-config.md（B: 1 / W: 6）

## カバレッジ

- 確認申告ゼロのファイル: なし（220件すべてが1体以上のレビュアーに言及されていることを機械検証済み）
- 各レビュアーの申告: DOM 98+122 / ADP 150+70 / SEC 148+72 / TEST 90+130 / PRES 78+142 — いずれも合計220で一覧と1対1

## 独立収束した指摘（複数レビュアーが同一問題に到達）

信頼度が高い。優先して潰す。

| 問題 | 到達したレビュアー |
|---|---|
| リセットトークンの保存形式（照合値の原像が平文で同居・FNV-1a-64・発行/配送/検証が合成不能） | SEC-B-001 / ADP-B-003 / SEC-W-001 |
| `SEND_MAIL_EMPTY_RETENTION_MS` が死にコードでリセット再依頼が24時間封鎖 | ADP-B-001 / SEC-W-002 |
| `requestPasswordReset` が active 世代の locator しか見ない | SEC-W-004 / ADP-W-009 |
| AC-3 の非露出テストが実値を見ておらず空振り | SEC-W-005 / TEST-W-003 |
| `Email.create` の非 ASCII ドメイン経路の非対称・構文検査不足 | DOM-W-006 / SEC-W-008 |

## 指摘一覧

### Blockers

- [DOM-B-001] `application/di/facades.ts` が adapters から型 import（application → adapters の逆流が復活） — `packages/core/src/application/di/facades.ts:1-12`
- [DOM-B-002] `User.credentials` は読み取り射影なのに `addCredential`/`removeCredential` を公開し `save` が書かない（spec の手順が黙って no-op） — `packages/core/src/domain/identity/entity.ts:77-119`
- [ADP-B-001] パスワードリセット再依頼が24時間「成功したのに送信されず、既存の有効リンクだけ破壊」 — `packages/core/src/lib/jobBudgets.ts:37-42`
- [ADP-B-002] `alarm()` から例外が逃げうる（捕捉がゲートと1ジョブ分のみ。SQLITE_FULL で `claimJob` が抜ける） — `apps/web/app/durable-objects/userData.ts:146-174`
- [ADP-B-003] リセットトークンが照合値を平文保存＋非暗号学的64bitハッシュ＋発行/配送/検証が合成不能 — `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:12-40`
- [SEC-B-001] リセットトークン保存が「DB 漏えい時に使えない」を満たさない（原像 `token_id` が同じ行に平文で並ぶ） — `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:21-40`
- [SEC-B-002] ジョブランナーが `operation_key`（完全長 HMAC を含む）と生の例外をログ出力し AC-3 に違反 — `packages/core/src/adapters/cloudflare/jobs/runner.ts:109-114`
- [TEST-B-001] テストヘルパに生の NUL バイト（plan.md が名指しで禁止した失敗様式） — `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts:19`
- [TEST-B-002] AC-2「signup saga の部分失敗・再試行が冪等」を検証するテストが皆無 — `packages/core/src/application/identity/signupSaga.ts:104-207`
- [TEST-B-003] AC-10「保持日数変更が同一トランザクションで全項目再計算」が未検証 — `packages/core/src/adapters/cloudflare/userData/facade.ts:137-181`
- [TEST-B-004] `docs/test.md` の fake ポリシーが両方とも未実装 — `docs/test.md`
- [PRES-B-001] ストリーミングのスケルトンが実 DOM と不一致（2行 vs 1行） — `apps/web/app/components/settings/SettingsSkeleton/index.tsx:1-30`

### Warnings

Domain / Use Case: DOM-W-001〜008 / Adapter: ADP-W-001〜009 / Security: SEC-W-001〜008 / Test: TEST-W-001〜016 / Presentation: PRES-W-001〜006。
各レイヤー別ファイルを参照。
