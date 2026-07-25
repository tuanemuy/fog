# REG-NAV: 既存機能への影響確認 — ナビゲーションの開閉とフォーカス

**結果**: PASS
**セッション**: verify-appshell

対象: `AppShell` のナビシート内のクラスを触ったことによる、メニューボタン → シート先頭リンクへのフォーカス移動 / Escape での閉じ / オーバーレイクリックでの閉じ。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ビューポート 390x844 の `/settings` でメニューボタン（`aria-label="メニュー"`）をクリック | シートが開き、先頭リンクへフォーカスが移る | `#global-nav-sheet` 出現。`document.activeElement` が `<a>`「タイムライン」＝ シート内の先頭リンク（`ae === sheet.querySelector('a')` が true）。`aria-expanded` が `true` に、背面の `div` に `inert` が付与される | PASS |
| 2 | シートを開いた状態で Escape を押す | シートが閉じ、フォーカスがメニューボタンへ戻る | `#global-nav-sheet` 消失、オーバーレイも消失。`document.activeElement` = `button[aria-label="メニュー"]`（`focusIsBtn: true`）、`aria-expanded="false"` | PASS |
| 3 | 再度メニューボタンでシートを開く | 1 と同じ挙動 | 先頭リンク「タイムライン」へフォーカス、オーバーレイ出現、背面 `inert` 付与 | PASS |
| 4 | オーバーレイ（`aria-label="メニューを閉じる"`）をクリック | シートが閉じ、フォーカスがメニューボタンへ戻る。ページ遷移はしない | シート・オーバーレイともに消失、`focusIsBtn: true`、`aria-expanded="false"`、URL は `/settings` のまま | PASS |
| 5 | シート内の DOM 構造・区切り線を確認（クラス変更の副作用） | 先頭項目のみ `border-top` なし | タイムライン 0px / トピック・検索・ゴミ箱・設定 1px。現在ページ「設定」に `aria-current="page"` と `font-semibold` が付与されたまま | PASS |
| 6 | シート展開状態で `margin-bottom !== 0px` の要素を走査 | 0 件 | `h1.sr-only` の `-1px`（Tailwind `sr-only` 由来）のみ。`grep -rE '\b(mb\|my)-' apps/web/app` も 0 件 | PASS |

## 計測値・状態スナップショット

開いた直後（390x844）:

```
sheetPresent: true, overlay: true
activeElement: <a> "タイムライン" (= sheet.querySelector('a'))
inert: 背面 div に付与あり
menu button aria-expanded: true
```

Escape 後 / オーバーレイクリック後（いずれも同じ）:

```
sheetPresent: false, overlay: false
activeElement === button[aria-label="メニュー"] (focusIsBtn: true)
menu button aria-expanded: false
location.pathname: /settings （遷移なし）
```

シート内リンクの区切り線:

| 項目 | border-top | margin-top | margin-bottom |
|---|---|---|---|
| タイムライン | 0px | 0px | 0px |
| トピック | 1px | 0px | 0px |
| 検索 | 1px | 0px | 0px |
| ゴミ箱 | 1px | 0px | 0px |
| 設定（current） | 1px | 0px | 0px |

余白（ハンドル → 先頭項目 14px）はラッパー `div.mt-md` が保持しており、`border-t` の分岐（`index === 0`）と直交している。

## 気づいた点

- フォーカス移動は `useEffect` の `sheetRef.current?.querySelector("a")?.focus()` に依存しており、シート先頭が常に `<a>`（ハンドルは `div aria-hidden`）である前提が保たれている。今回の余白ラッパー `div.mt-md` の追加はリンクより前に入らないため影響なし。
- ログイン資格情報について: testing.md 指定の `test@example.com` / `password123` はログインに失敗した（DB にレコードは存在するがパスワード不一致）。ナビゲーション検証は `/signup` で作成した `appshell-check@example.com` / `password123` で実施した。
