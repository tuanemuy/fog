# TC-2: 保存されたハッシュが `pbkdf2-sha512` / `210000` になっている

**結果**: PASS
**実行時間**: 約 10 秒

対応する受け入れ基準: AC-4 / AC-5

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | TC-1 実施後に `wrangler d1 execute ... --local --command "SELECT email, auth_method, password_hash FROM users WHERE email = 'pbkdf2-new@example.com';"` | 1行返る | 1行返った（下記） | PASS |
| 2 | `password_hash` を `$` で4フィールドに分けて読む | 4フィールド | 4フィールドに分割できた | PASS |
| 3 | 4フィールド目（derived）の base64 をデコードしてバイト長を数える | 32 | **32** | PASS |

### 読み取った行（全文）

```
email:         pbkdf2-new@example.com
auth_method:   password
password_hash: pbkdf2-sha512$210000$A+nBkT1WYxS42vc1/mL2og==$YvS1t70atHVpLKrQTu33wKPwpTc6dXLS/aX65KfbEWs=
```

### 4フィールドの内訳

| フィールド | 値 | 期待 | 判定 |
|---|---|---|---|
| 1. 識別子 | `pbkdf2-sha512` | `pbkdf2-sha512` | PASS |
| 2. 反復回数 | `210000` | `210000` | PASS |
| 3. salt（base64） | `A+nBkT1WYxS42vc1/mL2og==` — base64 で **24文字**、デコード後 **16 byte** | base64 24文字 / 16 byte | PASS |
| 4. derived（base64） | `YvS1t70atHVpLKrQTu33wKPwpTc6dXLS/aX65KfbEWs=` — base64 で **44文字**、デコード後 **32 byte** | base64 44文字 / 32 byte（`DERIVED_BITS = 256` 据え置き） | PASS |

デコード確認コマンドと結果:

```
$ printf '%s' 'YvS1t70atHVpLKrQTu33wKPwpTc6dXLS/aX65KfbEWs=' | base64 -d | wc -c
      32
$ printf '%s' 'A+nBkT1WYxS42vc1/mL2og==' | base64 -d | wc -c
      16
```

## 確認ポイントの結果

- `auth_method` が `password` であること — **PASS**
- 識別子と回数のちぐはぐが無いこと — **PASS**。識別子は `pbkdf2-sha256` ではなく `pbkdf2-sha512`、回数は不採用の案 B の `600000` ではなく `210000`。案 A の行と厳密に一致
- derived が 32 byte であること（`DERIVED_BITS` を触っていない）— **PASS**

## サーバーログ（テスト中に増えた差分）

- `SystemError` / `CryptoError` / `DataIntegrityError` / `Login timing equalisation is inactive` — **いずれも出ていない**
- 増えたのは既存の vite `inputValidator() is deprecated` 警告と TanStack Start の CSRF ミドルウェア注意喚起のみ

## 失敗詳細（FAILの場合）

なし。
