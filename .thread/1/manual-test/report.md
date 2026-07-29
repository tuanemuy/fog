# Browser Verify Report — Issue #1 / PR #17

**実行日時**: 2026-07-25
**テストソース**: `.thread/1/testing.md`
**サーバー**: http://localhost:3000（`pnpm dev` / Node + libSQL）
**修正ラウンド**: 0回（初回で全 PASS）

---

## サマリー

| 項目 | 値 |
|---|---|
| テストケース総数 | 26 |
| PASS | 26 |
| FAIL | 0 |
| PASS率 | 100% |
| 起票Issue数 | 0 |

内訳: 通常系 9 / 異常系 11 / 既存機能への影響確認 6

---

## シードデータ

`pnpm db:migrate` でクリーンな DB を作り直したうえで、testing.md の方針どおり `/signup` からテストユーザーを作成した（専用のシードスクリプトは使わない）。

| アカウント | 作成元 | 用途 |
|---|---|---|
| `test@example.com` / `password123` | 通常系-2 | 全グループ共通のログイン検証 |
| `boundary1@example.com` / `abcd1234` | 異常系-2 | パスワード8文字境界 |
| `new-user+tc13@example.com` / `password123` | 異常系-3 | メール形式エラー後のリトライ |
| `new-user2@example.com` / `password123` | 異常系-5 | メール正規化（入力は `  New-User2@Example.COM  `） |
| `boundary2@example.com` ほか境界系 | 異常系-7〜9 | 連打防止・長さ境界 |

環境変数は `apps/web/.env` の既存値をそのまま使用（`SESSION_SECRET` は32文字以上）。異常系-10 で一時的に変更したが、バックアップから復元しバイト単位一致を確認済み。

---

## テスト結果一覧

| TC | テスト名 | 種別 | 最終結果 | 初回結果 | 修正ラウンド |
|----|---------|------|---------|---------|-------------|
| 通常系-1 | 未ログインでトップにアクセスするとログイン画面に誘導される | 正常系 | PASS | PASS | - |
| 通常系-2 | `/signup` で登録ができタイムラインへ遷移する | 正常系 | PASS | PASS | - |
| 通常系-3 | `/login` でメール＋パスワードログインができる | 正常系 | PASS | PASS | - |
| 通常系-4 | ログアウト後は保護画面にアクセスできない | 正常系 | PASS | PASS | - |
| 通常系-5 | 保護 URL 直アクセス後、ログインで元の URL へ戻る | 正常系 | PASS | PASS | - |
| 通常系-6 | グローバルナビの全項目から遷移でき現在地が示される | 正常系 | PASS | PASS | - |
| 通常系-7 | `/settings` に現在のユーザー情報が表示される | 正常系 | PASS | PASS | - |
| 通常系-8 | 認証画面どうしの導線がすべて機能する | 正常系 | PASS | PASS | - |
| 通常系-9 | レスポンシブ（PC サイドバー / モバイル下部シート） | 正常系 | PASS | PASS | - |
| 異常系-1 | 登録済みメールは重複エラー＋ログイン導線 | 異常系 | PASS | PASS | - |
| 異常系-2 | 弱いパスワード（7文字）でエラー、8文字で登録可 | 異常系 | PASS | PASS | - |
| 異常系-3 | メールアドレスの形式不正でエラー | 異常系 | PASS | PASS | - |
| 異常系-4 | 必須項目が未入力だとエラー | 異常系 | PASS | PASS | - |
| 異常系-5 | メールアドレスの正規化が効く | 異常系 | PASS | PASS | - |
| 異常系-6 | ログイン失敗時に原因を明かさない同一メッセージ | 異常系 | PASS | PASS | - |
| 異常系-7 | 登録ボタンの連打で二重登録されない | 異常系 | PASS | PASS | - |
| 異常系-8 | パスワード最大長の境界（129 / 128文字） | 異常系 | PASS | PASS | - |
| 異常系-9 | メールアドレス最大長の境界（321 / 320文字） | 異常系 | PASS | PASS | - |
| 異常系-10 | `SESSION_SECRET` 不正時の起動時エラー | 異常系 | PASS | PASS | - |
| 異常系-11 | セッション Cookie の改ざん | 異常系 | PASS | PASS | - |
| 影響-1 | `/todo` サンプルルートの消滅 | 影響確認 | PASS | PASS | - |
| 影響-2 | デザイントークン差し替えの影響（Skeleton 可視性含む） | 影響確認 | PASS | PASS | - |
| 影響-3 | ルート遷移時の pending 表示 | 影響確認 | PASS | PASS | - |
| 影響-4 | outbox / relay のイベントデコーダ登録 | 影響確認 | PASS | PASS | - |
| 影響-5 | マイグレーションの冪等性 | 影響確認 | PASS | PASS | - |
| 影響-6 | サイト名・メタ情報の fog 化 | 影響確認 | PASS | PASS | - |

---

## 起票した Issue

なし（FAIL ゼロ）。

---

## 実測で裏付けた主要な確認ポイント

- **セッション Cookie の属性** — `fog_session` に `HttpOnly` / `SameSite=Lax` / `Path=/`（`Secure` は http localhost のため false）。CDP の `Network.getAllCookies` で確認
- **ログアウト後の履歴** — `history.length` がログアウト前後で変わらず `replace` 遷移。戻るボタンでは `/login?redirect=%2F` に着地し保護画面は復元されない。Cookie は失効
- **資格情報の非露出** — `/settings` の DOM 全文（63,959文字）とセッション Cookie 付きサーバー生 HTML（15,783 bytes）の両方に対し `password123` / `pbkdf2` / `argon` / `bcrypt` / `scrypt` / `passwordHash` / `ssoSubject` / `salt` / `hash` を grep → 全件ヒット0
- **ログイン失敗の応答同一性** — パスワード誤り・未登録メール・形式不正の3ケースで、文言・要素（`<p role="alert" tabindex="-1">`）・DOM 上の位置がすべて完全一致
- **エラーの表示層** — 129文字パスワード・321文字メールとも、transport 由来の汎用文言（「入力形式が不正です」）ではなく**項目直下のドメイン由来メッセージ**が出ることを確認
- **秘密鍵の非露出** — `SESSION_SECRET=short` で全リクエストが 500 になり、`Set-Cookie` は返らない（不正な鍵でセッションが発行されない）。ログ・レスポンス本文とも秘密鍵の値の出現は0件
- **Skeleton の可視性** — `--color-neutral-300` = `rgb(213,213,218)` に対し `--color-bg-page` = `rgb(231,231,234)` で不一致（コントラスト比 1.19）。`--color-neutral-200` はページ背景と完全一致するため、Skeleton が 300 を使う設計が実測で裏付けられた
- **outbox / relay** — `No decoder registered` 系のエラーは0件。`[queue] received identity.userRegistered` が登録7件と1対1で対応し、outbox 7件すべて処理済み・失敗0・リトライ0
- **レスポンシブ** — 検証した全7ページ × 両幅（1280px / 375px）で `scrollWidth == clientWidth`（横スクロールなし）

---

## 参考情報（判定には含めない）

- サーバーログ 14:44:32 に `SerovalDeserializationError` → 500 が**1回だけ**存在するが、直前行が `LoginForm/action.ts` の Vite RSC 再コンパイル通知であり、HMR 直後に旧クライアントチャンクが新 server function へ POST した dev 固有の事象と判断した。検証中（登録3件・ログイン4回・Cookie 改ざん・404 アクセス）は一度も再現していない
- 異常系-4 で、メール空・パスワード入力ありのケースではエラー後にパスワード欄の値が保持されない。これは `SignupForm/index.tsx` に明記された意図的な設計（React 19 のフォームリセット対策で email のみ state に持ち回す。パスワードは意図的に保持しない）。メールアドレスの保持は確認済み

## テスト実行上の留意点（アプリの不具合ではない）

- `AGENT_BROWSER_IDLE_TIMEOUT_MS` が短いとテスト中に agent-browser のデーモンが再起動し、セッション Cookie とページ状態が失われる。`900000` の設定を推奨
- agent-browser で `fill` は効くが click / press が届かなくなる事象が数回発生した。セッションを close → 再オープンで復旧する
- `agent-browser cookies get` は本環境で常に空配列を返すため、Cookie 属性の確認は CDP の `Network.getAllCookies` を直接叩いた
- `type="email"` / `required` のネイティブ検証が先に効くため、異常系3・4・6の一部手順は `form.noValidate = true` を eval で設定してサーバー経路まで通した
- 異常系5の「前後空白」はブラウザの value sanitization が自動除去するため、eval で一時的に `input.type='text'` にして生の値を FormData に載せ、サーバー側 trim を確認した
