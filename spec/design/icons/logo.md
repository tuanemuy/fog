# fog ロゴ

採用案の決定記録。提案の経緯と比較は [proposals.html](./proposals.html) を参照。

## 決定

- アイコン: **Dot & Mist**（霧の2本線 ＋ 右上の点）。霧＝雑多なメモ、点＝その中にある確かな価値。点は既存ブランドの橙ドット（`--color-accent`）を継承する
- Wordmark: **Avenir Next Regular / lowercase**、tracking −0.022em。トークン規約で Web フォントは使えないため、字形はアウトライン化した SVG パスとして保持する（実行環境のフォントに依存しない）
- lockup 末尾の 6px ドットは廃止。橙の「点」はアイコン内の1つに集約し、二重ドットを避ける。モバイルヘッダー（タイトル横）のドットはブランドの反復として存続

## 構成ファイル

| ファイル | 内容 |
|---|---|
| `logo.svg` | アイコン単体（24 グリッド、線 `#191a1d` × 点 `#e8590c`） |
| `logo-mono.svg` | アイコン単色版（`currentColor`。刻印・単色印刷など差し色を使えない文脈用） |
| `lockup.svg` | アイコン ＋ Wordmark の確定 lockup（viewBox `0 0 120 44`） |

アプリ側の配布物（`apps/web/public/`）:

| ファイル | 内容 |
|---|---|
| `favicon.svg` | 小サイズ最適化版（線 2.2 / 点 r2.2 に太らせ、ダークモードで線を反転） |
| `favicon.ico` | 16 / 32 / 48px |
| `apple-touch-icon.png` | 180px。`#191a1d` 地に白線 ＋ 橙点のタイル |
| `icon-192.png` / `icon-512.png` | `site.webmanifest` 用（apple-touch-icon と同デザイン） |
| `og-image.png` | 1200×630。ページ背景色 `#e9e9ed` に lockup をセンタリング |

UI 内の lockup は `apps/web/app/components/ui/Brand` にインライン SVG として実装し、デザインモック（`../pages/*.html`）の `.brand` にも同じ SVG を埋め込んでいる。表示サイズ 57.3×21px は置き換え前の 17px Wordmark と x-height を揃えた値。

## 幾何

- アイコンは 24 グリッド、線 `M4.5 12 H19.5 M7 16 H15`（stroke 1.7 / round cap）、点 `cx16.5 cy7 r1.8`
- lockup はアイコン 42px ＋ gap 18px ＋ Wordmark（font-size 40px 相当）。ベースライン y=33.68 は提案ページの flexbox センタリング（42px ボックス同士）を再現した値
- favicon だけ線 2.2 / 点 r2.2。16〜32px でのかすれを防ぐ光学補正で、他のサイズには適用しない

## 再生成

Wordmark のパスは macOS の `/System/Library/Fonts/Avenir Next.ttc` から fontkit（Node）で `AvenirNext-Regular` の `f` `o` `g` を抽出したもの（UPM 1000、字間 −22/1000em）。ラスター群は ImageMagick（RSVG デリゲート）で SVG から書き出す。字形やサイズを変えるときは同じ手順で lockup から作り直す。
