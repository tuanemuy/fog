# 通常系-9: レスポンシブ（PC はサイドバー / モバイル幅は下部シート）

**結果**: PASS
**対応する受け入れ基準**: AC-14 / AC-18
**実行時間**: 約110秒

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログイン状態で `/` を開き、幅を 1280px にする | 常設サイドバーにナビ5項目が並ぶ | `aside` が `display:flex` / `position:static` / 200x900px、内部の `nav[aria-label="グローバルナビゲーション"]` に 5 リンク。「メニュー」ボタンは `display:none`（0x0） | PASS |
| 2 | 1280px で横スクロールを確認 | 横スクロールが発生しない | `documentElement.scrollWidth` 1280 == `clientWidth` 1280 | PASS |
| 3 | 幅を 375px にする | サイドバーが消え、ヘッダーに「メニュー」ボタンが出る | `aside` が `display:none`（0x0）。ヘッダーに `button[aria-label="メニュー"]`（35x35, `aria-expanded="false"`, `aria-controls="global-nav-sheet"`）が出現。a11y ツリー上もサイドバーは消え `banner` に button "メニュー" のみ | PASS |
| 4 | 375px で「メニュー」ボタンを押す | 下部シートのナビが開き5項目が並ぶ | `#global-nav-sheet` が `position:fixed` / 347x350px / y=462 で画面下端に密着（`innerHeight - bottom = 0`）。リンク5件「タイムライン/トピック/検索/ゴミ箱/設定」。ボタンは `aria-expanded="true"` に変化し、ラベルが「メニューを閉じる」になる | PASS |
| 5 | 開いたシートから「設定」を押す | `/settings` へ遷移できる | URL `/settings`、title「設定」、h1「設定」。シートは自動的に閉じ（`#global-nav-sheet` が DOM から消え、`aria-expanded="false"`） | PASS |
| 6 | 375px で全認証後画面の横スクロールを確認 | 横スクロールが発生しない | `/`・`/topics`・`/search`・`/trash`・`/settings` すべてで `scrollWidth` 375 == `clientWidth` 375 == `body.scrollWidth` 375。`innerWidth` を超えて右にはみ出す要素は 0 件 | PASS |
| 7 | 375px で `/login` `/signup` の崩れを確認 | フォームが崩れない | `/login`: email / password 入力欄と「ログイン」ボタンがいずれも `x=38, width=299`（49/49/47px 高）、リンク2本も同幅で整列。`/signup`: 同じく `x=38, width=299`。両ページとも `scrollWidth` 375 == `clientWidth` 375、はみ出し要素 0 件 | PASS |
| 8 | 1280px の `/login` を確認 | 崩れない | `scrollWidth` 1280 == `clientWidth` 1280。フォーム要素は正常表示 | PASS |

## 確認ポイントの検証

- **横スクロール**: 検証した全ページ（`/`, `/topics`, `/search`, `/trash`, `/settings`, `/login`, `/signup`）の 375px / 1280px 双方で `document.documentElement.scrollWidth <= clientWidth` を満たした。
- **切り替えの境界**: `lg:`（1024px）ブレークポイントで、`aside`（常設サイドバー）と「メニュー」ボタン＋下部シートが排他的に切り替わる。両方が同時に見えることはない。
- **下部シート**: `position:fixed` で画面下端に密着し、ナビ5項目すべてから遷移可能。遷移時に自動で閉じる。

## 補足

- ビューポート変更のみ（リロードなし）でも CSS メディアクエリにより表示形態は切り替わる。リロード後も同じ結果。

## 失敗詳細

なし。
