# テスト実行サマリー — Issue #20

**実行日時**: 2026-08-07
**テストソース**: `.thread/20/testing.md`
**サーバー**: http://localhost:3000（`pnpm dev` / Cloudflare Workers + ローカル D1）
**ブランチ**: `issue/20/pbkdf2-cost-parameters`（確認項目4 の手順3-4 のみ `main`）

| TC | テスト名 | 種別 | 結果 | 失敗ステップ |
|----|---------|------|------|-------------|
| TC-1 | 新規登録 → ログアウト → ログインの往復 | 正常系 | PASS | - |
| TC-2 | 保存ハッシュが `pbkdf2-sha512` / `210000` | 正常系 | PASS | - |
| TC-3 | ダミーハッシュが出荷ハッシャーで読めている | 正常系 | PASS | - |
| TC-4 | 変更前に作成したアカウントでログインできる | 正常系 | PASS | - |
| TC-5 | 旧形式の低コストフィクスチャでログインできる | 正常系 | PASS | - |
| TC-6 | 旧形式の行はログイン成功後も書き換わらない | 正常系 | PASS | - |
| TC-7 | ログインの体感速度が実用の範囲 | 正常系 | PASS | - |
| TC-edge-1 | ログイン失敗の表示が理由によらず同一 | 異常系 | PASS | - |
| TC-edge-2 | 未知の識別子の行は資格情報エラーに潰れない | 異常系 | PASS | - |
| TC-edge-3 | パスワード長の境界（128文字） | 異常系 | PASS | - |
| TC-regression-a | セッション Cookie / `/settings` 表示 / pending 表示 | 既存影響 | PASS | - |

**合計**: 11 件（PASS: 11 / FAIL: 0）

## 主要な観測値

**出荷される保存形式**（TC-2 / TC-edge-3）:

```
pbkdf2-sha512$210000$A+nBkT1WYxS42vc1/mL2og==$YvS1t70atHVpLKrQTu33wKPwpTc6dXLS/aX65KfbEWs=
```

識別子 `pbkdf2-sha512` / 反復回数 `210000` / salt 16 byte / derived **32 byte**（`DERIVED_BITS = 256` 据え置き）。不採用の案 B の値（`600000`）も旧識別子（`pbkdf2-sha256`）も出現しない。

**旧形式の読み取り**（TC-4 / TC-5 / TC-6）: `main` で作った `pbkdf2-sha256$210000$…` と、単体テストが固定している低コストフィクスチャ `pbkdf2-sha256$1000$…` の**両方**が実装ブランチでログインでき、ログイン後も**バイト単位で不変**（rehash-on-login の混入なし）。

**等時間化**（TC-3）: `Login timing equalisation is inactive` の警告はサーバーログ全体で **0 件**。ログ経路が死んでいないことは `lsof` で stdout/stderr の向き先を確認して裏取り済み。

**エラー契約**（TC-edge-2）: 未知識別子 `argon2id` の行に対して、画面は「システムエラーが発生しました」、サーバーログに `DATA_INTEGRITY_ERROR` / `Stored password hash is not in a recognised encoding` がスタック付きで出力。**資格情報エラーに潰れていない**。ハッシュ値・スタックトレースの画面露出なし。

**体感速度**（TC-7）: ハッシュを踏まない同形状の遷移をベースラインに取り、ログイン送信の差分は中央値 **+53ms**、登録は +67ms。testing.md の先行実測（ローカル workerd で1導出 45〜47ms）と同じ桁で、1秒級の桁違いは観測されず。

## 実機で確認しなかった項目（testing.md「対象外」節の宣言どおり）

AC-1 / AC-2 / AC-3（workerd 実測プローブ・CI）、AC-9 / AC-11（型ピンと `pnpm typecheck`）、AC-6 の識別子対応表・拒否ケース表（アダプター単体テストが権威）、AC-10 / AC-12 / AC-13 / AC-15（記述の訂正）、AC-14（テスト・lint・format）。

## 検証で残したローカルデータ

ローカル D1（`apps/web/.wrangler/`、gitignore 済み）に検証用アカウントが4件残っている。本番データではなく、ブランチにも影響しない。

| アドレス | 保存形式 |
|---|---|
| `pbkdf2-new@example.com` | `pbkdf2-sha512$210000$…` |
| `pbkdf2-timing-tca@example.com` | `pbkdf2-sha512$210000$…` |
| `pbkdf2-long@example.com` | `pbkdf2-sha512$210000$…` |
| `pbkdf2-legacy@example.com` | `pbkdf2-sha256$1000$…`（低コストフィクスチャを注入したまま） |

`outbox_events` に `identity.userRegistered` が4行（登録4件と整合）。`pnpm db:migrate` の再実行は「No migrations to apply!」で冪等。`apps/web/*.sql` の残骸なし。

## 手順どおりに実施できなかった点（正直な記録）

- **確認項目7 の DevTools 計測**: agent-browser は DevTools の Network タブを開けないため、操作前後の時刻差にベースライン差分を取る方法で代替した。手順の意図（桁が変わっていないかを見る）は満たしているが、観測手段は手順書のままではない。
- **連打による二重登録・二重ログインの防止**: 送信中にボタンへ `disabled` が付くこと（`button "ログイン中…" [disabled]`）は確認したが、実際に連打して二重送信が起きないことまでは検証していない。
- **タイミング残差の実測**: testing.md「正直な限界」節が「この手順では測れない」と結論づけているため、意図的に測定していない。「測って差が無かった」ではない。
