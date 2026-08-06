# TC-edge-1: ログイン失敗の表示が失敗理由によらず同一である

**結果**: PASS
**実行時間**: 約 130 秒（TC-3 とブラウザフローを共用）

対応する目的: `loginWithPassword` が「誤ったパスワード」と「存在しないメールアドレス」を同一の `INVALID_CREDENTIALS` に潰す挙動が、方式差し替え後も壊れていないこと
実行ブランチ: `issue/20/pbkdf2-cost-parameters`
セッション: `verify-tc-b`（agent-browser）

**検証対象は表示の同一性のみ。** testing.md「正直な限界（重要）」節が「応答時間の差はこの手順では検証できない」「『測って差が無かった』ではなく『この手順では測れない』が正しい結論」と明記しているため、応答時間は計測も比較もしていない。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/login` で `pbkdf2-new@example.com` / `wrongpassword` を送信 | 資格情報エラーが出る。文言と位置を控える | `form` 直下の第1子 `alert` に「メールアドレスまたはパスワードが正しくありません」 | PASS |
| 2 | `/login` で `no-such-user@example.com` / `password123` を送信 | 手順1と**まったく同じ文言が同じ位置**に出る | `form` 直下の第1子 `alert` に「メールアドレスまたはパスワードが正しくありません」。snapshot 差分は入力欄に残ったメールアドレス値のみ | PASS |
| 3 | `/login` で `pbkdf2-new@example.com` / `password123` を送信 | ログインできる | `http://localhost:3000/` のタイムラインへ遷移。`heading "タイムライン"` + 「まだメモがありません」 | PASS |
| 4 | 英語の生の例外文言 / スタックトレース / 500 画面の有無 | 出ない | 手順1・2 とも日本語の資格情報エラーのみ。スタックトレース・例外クラス名・500 画面いずれも無し | PASS |

## 文言・表示位置の厳密比較

目視の印象ではなく、`snapshot --max-output 8000` で取得した文字列そのものを突き合わせた。

**手順1（誤ったパスワード / `pbkdf2-new@example.com` + `wrongpassword`）:**

```
- main
  - image "fog"
  - heading "ログイン" [level=1, ref=e1]
  - form
    - alert
      - StaticText "メールアドレスまたはパスワードが正しくありません"
    - LabelText
      - StaticText "メールアドレス"
    - textbox "メールアドレス" [required, ref=e5]: pbkdf2-new@example.com
      - StaticText "pbkdf2-new@example.com"
    - LabelText
      - StaticText "パスワード"
    - textbox "パスワード" [required, ref=e6]
    - button "ログイン" [ref=e7]
  - link "アカウント登録" [ref=e2]
  - link "パスワードを忘れた" [ref=e3]
```

**手順2（存在しないメールアドレス / `no-such-user@example.com` + `password123`）:**

```
- main
  - image "fog"
  - heading "ログイン" [level=1, ref=e1]
  - form
    - alert
      - StaticText "メールアドレスまたはパスワードが正しくありません"
    - LabelText
      - StaticText "メールアドレス"
    - textbox "メールアドレス" [required, ref=e5]: no-such-user@example.com
      - StaticText "no-such-user@example.com"
    - LabelText
      - StaticText "パスワード"
    - textbox "パスワード" [required, ref=e6]
    - button "ログイン" [ref=e7]
  - link "アカウント登録" [ref=e2]
  - link "パスワードを忘れた" [ref=e3]
```

**`diff` の結果（差分は 2 行のみ）:**

```
9,10c9,10
<     - textbox "メールアドレス" [required, ref=e5]: pbkdf2-new@example.com
<       - StaticText "pbkdf2-new@example.com"
---
>     - textbox "メールアドレス" [required, ref=e5]: no-such-user@example.com
>       - StaticText "no-such-user@example.com"
```

差分は**利用者自身が入力してフォームに残っているメールアドレス値だけ**である。エラーに関する部分は完全に一致している:

- **文言**: 両方とも `メールアドレスまたはパスワードが正しくありません` — バイト単位で同一
- **表示位置**: 両方とも snapshot の **5〜6 行目**、`form` 直下の**第1子** `alert` ロール。メールアドレス欄の `LabelText` より前
- **ロール**: 両方とも `alert`（フィールド単位のエラーではなくフォーム全体のエラーとして同じ扱い）
- 片方だけに出る追加要素（フィールド単位のエラー、「アカウントが存在しません」等の区別可能な文言）は存在しない

つまり、失敗理由の区別は表示から一切漏れていない。

## 検証しなかったこと（意図的）

- **応答時間の差** — testing.md「正直な限界（重要）」により、この手順では測定不能と明記されているため計測していない。`pnpm dev` の HMR・ネットワーク・描画ノイズが残差と同等以上に大きく、1〜数回の観測では有意差を判定できない。タイミングオラクルそのものの検証は自動テスト（`identity.integration.test.ts`）と確認項目3（TC-3）の警告ログに委ねられている。
- 手順1・2 はどちらも新形式 `pbkdf2-sha512$210000$` の行 / 未登録アドレスなので、そもそも設計上の残差はほぼゼロの組み合わせである（旧形式 `pbkdf2-sha256$` 行の約 97ms 残差は本ケースの対象外）。

## サーバーログ（テスト中に増えた差分）

テスト開始時点 154 行 → 終了時点 **154 行（増分ゼロ）**。ログの最終エントリは 4:30:06 で、テスト実行時刻（約 4:35〜4:37）より前。本テストの3回のログイン試行はログに1行も出力していない。

- `SystemError` — **出ていない**（ファイル全体で 0 件）
- `CryptoError` — **出ていない**（ファイル全体で 0 件）
- `DataIntegrityError` — **出ていない**（ファイル全体で 0 件）
- `Login timing equalisation is inactive` — **出ていない**（ファイル全体で 0 件）

いずれも差分だけでなくファイル全体（154行）を対象に grep して 0 件。既存 154 行の警告は #20 と無関係な TanStack Start / vite の既知警告のみ。

## 失敗詳細（FAILの場合）

なし。
