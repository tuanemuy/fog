# TC-C05: 設定画面がスケルトンから実データへストリーミングされる

**結果**: PASS
**対応する受け入れ基準**: AC-1 / AC-4

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | Network を Slow 4G に絞る | 遅延させて観察 | **代替手段を採用**。agent-browser にスロットリング命令が無いため、`MutationObserver` で `main` の DOM 変化を全フレーム記録する方式に置き換えた（下記） | 代替実施 |
| 2 | タイムラインから左ナビで `/settings` へ遷移 | 遷移する | `http://localhost:3000/settings`、`<title>` は「設定」、`heading "設定" [level=1]` | PASS |
| 3 | スケルトン → 実データの差し替わりを観察 | 先にスケルトン、その後アカウント情報 | 記録された遷移（同一ページ内、無スロットリング）:<br>`t+0ms` main = 「まだメモがありません」<br>`t+311ms` main = **「読み込み中」**（`SettingsSkeleton` の `<span class="sr-only">読み込み中</span>`。`<section role="status" aria-live="polite">`）<br>`t+636ms` main = 「アカウント / 認証方式 / メールアドレスとパスワード / ログアウト」<br>→ スケルトンが約 325ms 表示されてから実データへ差し替わった | PASS |
| 4 | 表示された「メールアドレス」が登録アドレスか | — | **画面にメールアドレスは表示されない**（下記「手順との差分」を参照）。表示は `認証方式 / メールアドレスとパスワード` | 手順が実装と不一致（アプリ側は正） |
| 5 | リロードして SSR 経路でも同じ内容が出る | 同じ内容 | リロード後も `main` = 「アカウント / 認証方式 / メールアドレスとパスワード / ログアウト」。URL・タイトルとも変化なし | PASS |
| 6 | レイアウトシフトの有無 | シフトなし | `PerformanceObserver('layout-shift')` の累積値 = **0**（`hadRecentInput` を除外した CLS） | PASS |
| 7 | 500 になっていないこと | ならない | ページは正常描画。`ErrorSurface` / `SettingsErrorScreen` は出ていない | PASS |

## 手順との差分（testing.md 手順4）

testing.md は「表示された『メールアドレス』が確認項目3 で登録したアドレスであること」を求めているが、**実装は意図的にアドレスを表示しない**。`apps/web/app/components/settings/CurrentUserPanel/index.tsx` のコメントが明示している:

> The address itself is deliberately absent: the original lives encrypted in the Identity Directory and is decrypted one at a time through an entry this issue does not implement (#12). What is shown here is the non-PII summary.

つまりこの手順は #37 の実装方針（および AC-3 の PII 非露出）と衝突しており、**手順側が古い**。画面に出るのは `credentials[].label` / `kind` から組み立てた非 PII の要約であり、testing.md の確認ポイントが求める「`CurrentUserPanel` が新しい `CurrentUserView` の形（`authMethod` が落ち `credentials` が入る）を読めているか」は満たされている — `credentials` を `usableForLogin` で絞り、`kind='email'` を「メールアドレスとパスワード」と表示している。

## 確認ポイントの結果

- **`CurrentUserPanel` が新しい形を読めているか** — 読めている。`usableForLogin` が true の credential 1件が「認証方式 / メールアドレスとパスワード」として描画される。`authMethod` に依存した表示は残っていない。
- **500 / stub factory / epoch ガード** — 該当なし。
