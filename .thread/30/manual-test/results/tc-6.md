# TC-6: スケルトンから実 DOM へのスワップでレイアウトシフトが起きない

**結果**: PASS
**セッション**: verify-appshell

対応する受け入れ基準: AC-6

## 検証方法（どちらを採ったか）

**動的計測（実測）で検証した。** 静的確認へのフォールバックは不要だった。

DevTools のスロットリングが agent-browser で使えないため、代わりに次の手順を採った。

1. `/`（タイムライン）を開いた状態で `eval` により 10ms 間隔のサンプラーを仕込む。各サンプルで `main section` とその子要素の `getBoundingClientRect().top` / `height` と `role` 属性を記録する。
2. サイドバーの「設定」リンクをクリックしてクライアントサイド遷移する（SPA 遷移なので `window` が保持され、サンプラーが生き残る）。
3. 2.5 秒後にサンプラーを停止し、記録した 253 サンプルを重複除去して**スケルトン表示中のフレーム**と**実 DOM のフレーム**の 2 状態を取得した。

補足として `SettingsSkeleton/index.tsx` と `CurrentUserPanel/index.tsx` のソースも読み、DOM 構造と余白クラスが 1:1 で対応していることを確認した（下記）。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/` でレイアウトサンプラーを設置（10ms 間隔） | サンプラーが動く | `sampler installed`、計 253 サンプル記録 | PASS |
| 2 | サイドバーの「設定」をクリックしてクライアントサイド遷移 | スケルトンが一瞬表示される | `role="status"` の `section`（`SettingsSkeleton`）を捕捉（t=6319ms） | PASS |
| 3 | 実データへのスワップを捕捉 | `CurrentUserPanel` に差し替わる | `role` 無しの `section`（h2「アカウント」始まり）を捕捉（t=6624ms） | PASS |
| 4 | 両フレームの `section` 自体の縦位置を比較 | 一致 | スケルトン **top 84** / 実 DOM **top 84** → **差 0px** | PASS |
| 5 | ラベル行・2 行・ログアウトボタンの各ブロック top を比較 | 下方向のガタつきがない | 84 / 108 / 156 / 205 → 84 / 107.34 / 157.17 / 208。差は 0 / -0.66 / +1.17 / +3.00px（累積のサブピクセル差のみ、上下の飛びなし） | PASS |
| 6 | ラベル相当 `Skeleton` の下に 8px が残っていないことを確認 | 余白は次の行の `mt-sm` 側 | スケルトンのラベル `span` は margin 0px、直後の行が `mt-sm`（8px）。ラベル bottom 100 → 行 top 108 = **8px**。実 DOM も h2 bottom 99.34 → 行 top 107.34 = **8px** で一致 | PASS |
| 7 | ソース照合（静的確認・補足） | 構造と余白クラスが 1:1 | 下表のとおり 4 ブロックすべてでクラスが一致 | PASS |

## 計測値

### 動的計測（クライアントサイド遷移中の 2 フレーム）

| ブロック | スケルトン top / height | 実 DOM top / height | top 差 |
|---|---|---|---|
| `section` 自体 | 84 | 84 | **0** |
| ラベル（`Skeleton` bar ↔ `h2` アカウント） | 84 / 16 | 84 / 15.34 | **0** |
| 1 行目（`ROW mt-sm`） | 108 / 48 | 107.34 / 49.83 | **-0.66** |
| 2 行目（`ROW border-t`） | 156 / 49 | 157.17 / 50.83 | **+1.17** |
| ログアウトブロック（`border-t pt-lg`） | 205 / 57 | 208 / 58.83 | **+3.00** |

ラベル → 1 行目の間隔: スケルトン **8px** / 実 DOM **8px**（完全一致）。
1 行目 → 2 行目、2 行目 → ログアウト: どちらも margin 0 + `border-top` で隣接（両者一致）。

### ソース照合（補足の静的確認）

| # | `SettingsSkeleton` | `CurrentUserPanel` | 一致 |
|---|---|---|---|
| 1 | `<Skeleton className={BAR} />`（margin なし） | `<h2 className="text-xs ...">`（margin なし） | ○ |
| 2 | `<div className={`${ROW} mt-sm`}>` | `<div className={`${ROW} mt-sm`}>` | ○ |
| 3 | `<div className={`${ROW} border-t border-neutral-100`}>` | `<div className={`${ROW} border-t border-neutral-100`}>` | ○ |
| 4 | `<div className="border-t border-neutral-100 pt-lg">` | `<div className="border-t border-neutral-100 pt-lg">` | ○ |

`ROW` 定数も両ファイルで同一（`flex items-center justify-between gap-md py-row`）。どちらにも `margin-bottom` は存在しない。

## 気づいた点

- ブロックの縦位置差は最大 3px（ログアウトブロック）で、これは**余白の担い手ではなくコンテンツ高さの差**に由来する。スケルトンのバーは固定高（`h-skeleton-line` = 16px）なのに対し、実 DOM のテキストは line-height 込みで 17.83px あり、行あたり約 1px ずつ累積する。Issue #30 の対象（余白の付け方）とは無関係で、以前から存在する差。気になるなら `h-skeleton-line` をテキストの行高に合わせると 0 にできる。
- スケルトンから実 DOM への切り替えは 305ms（t=6319 → 6624）でローカル環境でも十分観測できた。差し替え時に `section` の起点（top 84）が動かないため、下方向のガタつきは発生しない。
