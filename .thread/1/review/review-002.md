# PR Review #002 — [skeleton] 基盤＋アカウント登録・ログイン

**PR:** #17
**Date:** 2026-07-25
**Round:** 2回目

## Summary

- Blockers: 3
- Warnings: 24
- Notes: 49
- Verdict: **BLOCKED**

ラウンド1の指摘（Blocker 3 / Warning 45）は fix と仕分けた44件がすべて解消済み。本ラウンドの指摘は大半がラウンド1の修正が生んだ二次的な問題。

## レイヤー別ファイル

- Domain / Use Case: review-002-domain-usecase.md（B: 0 / W: 4）
- Infrastructure / Adapters: review-002-adapters.md（B: 0 / W: 5）
- Frontend: review-002-frontend.md（B: 2 / W: 7）
- Security: review-002-security.md（B: 0 / W: 4）
- Test: review-002-test.md（B: 1 / W: 4）

## 指摘一覧

### Blockers

- [B-001] ログアウト後の戻るボタンで保護画面が復元される（manual TC-23 が実際に落ちる） — `apps/web/app/presentation/currentUser.ts`（Frontend）
- [B-002] `main` をスクロールコンテナにした結果、新規ナビゲーションでスクロール位置が先頭に戻らない — `apps/web/app/router.tsx`（Frontend）
- [B-003] タイミングオラクル対策の検証テストが `FakePasswordHasher` 上で呼び出し回数しか数えず、定数が陳腐化して対策が死んでも green — `packages/core/src/application/identity/__tests__/identity.integration.test.ts`（Test）

### Warnings

**Domain / Use Case**

- [W-001] ダミーハッシュ定数の陳腐化が完全に無音（テスト無し・ログ無し・例外握り潰し） — `application/identity/loginWithPassword.ts:31-32,44-53`
- [W-002] 等時間化の前提（全保存ハッシュの反復回数がダミーの宣言値と一致）が未記載 — `application/identity/loginWithPassword.ts:23-32`
- [W-003] `progress.md` の残存課題が R1 修正後の実装と矛盾 — `.thread/1/progress.md:9-13`
- [W-004] 「`sessionCodec` はユースケースから参照禁止」が JSDoc だけで型に落ちていない — `packages/core/src/application/types.ts:3-6`

**Infrastructure / Adapters**

- [W-005] AWS の部分設定検出が空文字を「設定済み」と誤判定 — `infra/aws/bin/app.ts:16-52`
- [W-006] `fromBase64Url` の JSDoc が実態より広い保証を書いている — `adapters/webcrypto/encoding.ts:38-49`
- [W-007] R1 で追加したガード3本にテストが無い — `adapters/webcrypto/`
- [W-008] CLAUDE.md / docs が削除済みの todo 実装を「リファレンス」として名指ししている — `CLAUDE.md:58,60`, `docs/frontend_implementation_example.md`, `docs/test.md`
- [W-009] セッション鍵の最小長 32 が2箇所に二重定義 — `application/di/secrets.ts:34`, `adapters/webcrypto/hmacSessionCodec.ts:16`

**Frontend**

- [W-010] `AuthSheet` に `main` ランドマークが無く axe violation 2件 — `components/ui/AuthSheet/index.tsx`
- [W-011] `TextLink` がアクティブ時に `className="active"` で上書きされスタイルとフォーカスリングを喪失 — `components/ui/TextLink/index.tsx`
- [W-012] ブランドリンクにも `aria-current="page"` が自動付与され現在地が2箇所 — `components/layout/AppShell/index.tsx`
- [W-013] `head` が `links` を返さず canonical が全ページ `/` のまま — `routes/_app/*.tsx`
- [W-014] safe-area の修正が `viewport-fit=cover` 不在で常に発火しない — `routes/__root.tsx`
- [W-015] CLAUDE.md / docs が削除した基準形を指し続け `useOptimistic` の参照実装が消失（W-008 と同一 Key）
- [W-016] フォーム全体エラー時にフォーカスが `<body>` へ落ちる — `components/auth/{Login,Signup}Form/index.tsx`

**Security**

- [W-017] `Cache-Control: no-store` が server function 経路に付かない（R1 W-005 の修正がドキュメント経路しか覆っていない） — `apps/web/app/presentation/currentUser.ts`
- [W-018] `.env.example` / `.dev.vars.example` が下限を満たす既知の `SESSION_SECRET` を同梱 — `apps/web/.env.example`, `apps/web/.dev.vars.example`
- [W-019] deferred RSC レンダリング内の throw が `errorResponseMiddleware` を通らない — `apps/web/app/routes/_app/settings.tsx` ほか
- [W-020] `DUMMY_PASSWORD_HASH` の反復回数ハードコードで既定値を上げるとオラクルが復活 — `application/identity/loginWithPassword.ts`（W-001 と同一 Key）

**Test**

- [W-021] `if (!row) return;` が `eventRelayWorker.integration.test.ts` に4箇所残存＋`unitOfWork` 2箇所が `code` 未表明 — `application/workers/__tests__/eventRelayWorker.integration.test.ts`
- [W-022] R1 で新設したフェイルクローズのガード4本が「通る側」しか踏まれていない（W-007 と同一 Key）
- [W-023] AC-15 / manual TC-23 の根拠である `Cache-Control` と無効セッションの拒否経路が無テスト — `apps/web/app/presentation/__tests__/`
- [W-024] R1 で新設した `errorDisplay` の `FIELD_LABELS` / `formatFieldErrors` がどのテストからも到達しない — `apps/web/app/presentation/errorDisplay.ts`
