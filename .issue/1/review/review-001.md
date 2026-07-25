# PR Review #001 — [skeleton] 基盤＋アカウント登録・ログイン

**PR:** #17
**Date:** 2026-07-25
**Round:** 1回目

## Summary

- Blockers: 3
- Warnings: 45
- Notes: 52
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Domain / Use Case: review-001-domain-usecase.md（B: 0 / W: 6）
- Infrastructure / Adapters: review-001-adapters.md（B: 0 / W: 8）
- Frontend: review-001-frontend.md（B: 2 / W: 12）
- Security: review-001-security.md（B: 0 / W: 11）
- Test: review-001-test.md（B: 1 / W: 8）

## 指摘一覧

### Blockers

- [B-001] `TextField` のキーボードフォーカスリングが描画されない — `apps/web/app/components/ui/TextField/index.tsx:18`（Frontend）
- [B-002] 送信失敗時に入力値が消える（React 19 の form action 自動リセット） — `apps/web/app/components/auth/{LoginForm,SignupForm}/index.tsx`（Frontend）
- [B-003] オープンリダイレクト防止 `redirectSearch.ts` にテストが1件も無い — `apps/web/app/presentation/redirectSearch.ts:24-46`（Test）

### Warnings

**Domain / Use Case**

- [W-001] `changeTrashRetentionDays` の同値 no-op が spec / ADR に無く WHY コメントも無い — `packages/core/src/domain/identity/entity.ts:121-123`
- [W-002] `getCurrentUser` の出力 DTO が spec の平坦形と異なり入れ子 — `packages/core/src/application/identity/getCurrentUser.ts:10-12`
- [W-003] `User.reconstruct` のコメントが直和 CHECK 違反の検出範囲を過大に述べている — `packages/core/src/domain/identity/entity.ts:166-172`
- [W-004] VO の長さ検証が UTF-16 コードユニット長で spec の「文字」と不一致 — `packages/core/src/domain/identity/valueObject.ts:79,47,151`
- [W-005] `loginWithPassword` に未登録判定のタイミングオラクル — `packages/core/src/application/identity/loginWithPassword.ts:30-31,49-58`
- [W-006] `RequestSecrets.sessionSecret` が「不在」を `""` センチネルで表現 — `packages/core/src/application/di/secrets.ts:16`

**Infrastructure / Adapters**

- [W-007] マイグレーションタグ `0000_initial` の内容差し替え再利用が未文書化 — `packages/core/src/adapters/{d1,libsql}/migrations/`
- [W-008] `SESSION_SECRET` のドキュメントが GCP だけ更新。AWS は未設定ステージが黙って synth から消える — `docs/runtime_{node,cloudflare,aws}.md`
- [W-009] `keyPromise` のメモ化がリクエスト毎のコンテナ生成で無効化され JSDoc と食い違う — `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:50-62`
- [W-010] 暗号ファクトリが引数（secret 長・iterations）を検証しない — `hmacSessionCodec.ts:44-47`, `pbkdf2PasswordHasher.ts:122-125`
- [W-011] `users` の名前付き制約6本・部分一意インデックスに挙動テストが皆無 — `packages/core/src/adapters/{d1,libsql}/__tests__/userRepository.integration.test.ts`
- [W-012] 保存ハッシュの反復回数に上限検査が無い — `pbkdf2PasswordHasher.ts:74-80`
- [W-013] `requireSessionSecret` がリクエスト毎に生 `Error` を throw（redaction 境界の外） — `packages/core/src/application/di/secrets.ts:31-38`
- [W-014] `encoding.ts` の base64 系に JSDoc もテストも無く非正規入力受理が未文書化 — `packages/core/src/adapters/webcrypto/encoding.ts:1-24`

**Frontend**

- [W-015] `/settings` がブロッキングローダーで per-fragment streaming 未使用 — `routes/_app/settings.tsx:16,21-22`
- [W-016] `RoutePendingFallback` がトークン外の生値クラス — `components/ui/RoutePendingFallback/index.tsx:16-21`
- [W-017] transport 検証エラーが英語 zod メッセージ＋生フィールドキーのまま表示 — `presentation/errorDisplay.ts:46-56`
- [W-018] 項目単位エラーに live region がなくフォーカス誘導もない — `components/ui/TextField/index.tsx:76-80`
- [W-019] ボトムシートにフォーカス管理・`inert` がない — `components/layout/AppShell/index.tsx:56-63,147-182`
- [W-020] シェルのスクロールモデルが基準形と異なり PC サイドバーが常設にならない — `components/layout/AppShell/index.tsx:67,139`
- [W-021] `readAuthStateFn` が 3 ルートに逐語コピー — `routes/{login,signup,_app}.tsx`
- [W-022] `.form-link` 相当のプリミティブ不在でクラス列が 6 箇所重複 — `components/auth/LoginForm/index.tsx:89,95` ほか
- [W-023] 認証後ルートに `head` がなく全画面同一タイトル — `routes/_app/*.tsx`
- [W-024] ルートのエラー / 404 画面が未スタイルでリトライ導線なし — `routes/__root.tsx:51-65`
- [W-025] ボトムシートに `env(safe-area-inset-bottom)` 考慮なし — `components/layout/AppShell/index.tsx:159`
- [W-026] 送信中の入力欄 `disabled` でフォーカスが body に落ちる — `components/auth/LoginForm/index.tsx:59,73`

**Security**

- [W-027] ログイン失敗の応答時間でアカウント存在が漏れる — `packages/core/src/application/identity/loginWithPassword.ts:46-58`（W-005 と同一 Key）
- [W-028] PBKDF2 の rehash-on-login が未実装 — `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:108-111`
- [W-029] 認証エンドポイントのレート制限が皆無 + 重複チェック前に KDF を回す CPU 増幅 DoS — `apps/web/app/components/auth/LoginForm/action.ts:7`
- [W-030] CSRF 防御が `SameSite=Lax` 単独で Origin 検証がない — `apps/web/app/start.ts:4-6`
- [W-031] 認証済みレスポンスに `Cache-Control: no-store` が付かない — リポジトリ全体
- [W-032] ステートレスセッションの鍵ローテーション手順がドキュメントにない — `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:28-42`
- [W-033] AWS の CloudFront が `originRequestPolicy` 未指定で Cookie もクエリも転送しない — `infra/aws/lib/appStack.ts:234-241`
- [W-034] `SESSION_SECRET` の検証がリクエストごとで起動時ではない — `apps/web/app/server.node.ts:102`（W-013 と同一 Key）
- [W-035] `redirect` パラメータが制御文字を拒否していない — `apps/web/app/presentation/redirectSearch.ts:21-32`
- [W-036] `requireUserId()` の復帰先が `/_serverFn/...` になりうる — `apps/web/app/presentation/currentUser.ts:40-45`
- [W-037] セッション Cookie に `__Host-` プレフィックスがない — `apps/web/app/presentation/sessionCookie.ts:12`

**Test**

- [W-038] TC-registerWithPassword-014 がレース経路も成功件数も固定していない — `application/identity/__tests__/identity.integration.test.ts:279-290`
- [W-039] 境界「正常に登録される」系 TC が VO 層止まりで transport 境界を跨がない — `domain/identity/__tests__/valueObject.property.test.ts:29,93,100`
- [W-040] ハッシャー失敗系の `code` 表明がトートロジー・実アダプターの `CryptoError` 翻訳が無テスト — `adapters/webcrypto/pbkdf2PasswordHasher.ts:50-56`
- [W-041] 移植した OCC ガード / UoW テストに `if (!found) return;` と `expect(threw).toBe(true)` が残存 — `adapters/libsql/__tests__/occGuard.integration.test.ts:54,78,99`
- [W-042] AC-10 / AC-12 を決める `errorField.ts` が無テスト — `apps/web/app/components/auth/errorField.ts:37-92`
- [W-043] `startSession` が無テスト — `apps/web/app/presentation/session.ts:41-51`
- [W-044] 「平文でなくハッシュが保存される」を実ハッシャーで見るテストが無い — `application/identity/__tests__/identity.integration.test.ts:152`
- [W-045] 障害注入の `ALTER TABLE users RENAME` が失敗するとファイル全体を巻き込む — `application/identity/__tests__/identity.integration.test.ts:82-124`
