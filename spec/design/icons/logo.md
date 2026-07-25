# fog ロゴ

採用案の決定記録。提案の経緯と比較は [proposals.html](./proposals.html) を参照。

## 決定

- アイコン: **Dot & Mist**（霧の2本線 ＋ 右上の点）。霧＝雑多なメモ、点＝その中にある確かな価値。点は既存ブランドの橙ドット（`--color-accent`）を継承する
- Wordmark: **Avenir Next Medium / lowercase**、tracking −0.022em。トークン規約で Web フォントは使えないため、字形はアウトライン化した SVG パスとして保持する（実行環境のフォントに依存しない）。当初は Regular だったが、UI サイズで華奢に見えたため Medium に変更した
- lockup 末尾の 6px ドットは廃止。橙の「点」はアイコン内の1つに集約し、二重ドットを避ける。戻る付きページヘッダーの英語タイトル横のドットはブランドの反復として存続
- ヘッダー表示規則: トップレベル5画面（タイムライン / トピック / 検索 / ゴミ箱 / 設定）はタイトルの代わりに lockup（h1 は sr-only で維持。lg 以上ではサイドバーの brand があるため非表示）。戻るボタンを持つページは lockup ではなく短い英語タイトル — `topic`（トピック詳細）/ `history`（メモ履歴・ドキュメント履歴）/ `document`（ドキュメント）/ `edit`（編集）— を `--font-brand`（Avenir Next / Medium / lowercase）＋橙点で表示する（点は lg で非表示）。長くなり得る固有名（ドキュメントタイトル・トピック名）はヘッダーに置かず、シート内（`doc-title` / `doc-context`）に置く

## 構成ファイル

| ファイル | 内容 |
|---|---|
| `logo.svg` | アイコン単体（24 グリッド、線 `#191a1d` × 点 `#e8590c`） |
| `logo-mono.svg` | アイコン単色版（`currentColor`。刻印・単色印刷など差し色を使えない文脈用） |
| `lockup.svg` | アイコン ＋ Wordmark の確定 lockup（viewBox `0 0 64.7 26` — UI 実寸と 1:1 の座標系） |

アプリ側の配布物（`apps/web/public/`）:

| ファイル | 内容 |
|---|---|
| `favicon.svg` | 小サイズ最適化版（線 2.2 / 点 r2.2 に太らせ、ダークモードで線を反転） |
| `favicon.ico` | 16 / 32 / 48px |
| `apple-touch-icon.png` | 180px。`#191a1d` 地に白線 ＋ 橙点のタイル |
| `icon-192.png` / `icon-512.png` | `site.webmanifest` 用（apple-touch-icon と同デザイン） |
| `og-image.png` | 1200×630。ページ背景色 `#e9e9ed` に lockup をセンタリング |

UI 内の lockup は `apps/web/app/components/ui/Brand` にインライン SVG として実装し、デザインモック（`../pages/*.html`）の `.brand`・トップレベル画面の `.h-brand` にも同じ SVG を埋め込んでいる。表示サイズは 64.7×26px — アイコン 26px ＋ Wordmark 19px 相当（置き換え前の 17px テキストと同じ x-height 帯）。華奢さの対策は Wordmark の拡大ではなく「アイコンの拡大 ＋ Medium ウェイト」で取った。

## 幾何

- アイコンは 24 グリッド、線 `M4.5 12 H19.5 M7 16 H15`（stroke 1.7 / round cap）、点 `cx16.5 cy7 r1.8`
- lockup はアイコン 26px ＋ gap 10px ＋ Wordmark（font-size 19px 相当）。ベースライン y=19.02 は 19.95px のテキスト行ボックスを 26px のアイコンボックスに flexbox センタリングした値
- favicon だけ線 2.2 / 点 r2.2。16〜32px でのかすれを防ぐ光学補正で、他のサイズには適用しない

## 再生成

Wordmark のパスは macOS の `/System/Library/Fonts/Avenir Next.ttc` から fontkit（Node）で `AvenirNext-Regular` の `f` `o` `g` を抽出したもの（UPM 1000、字間 −22/1000em）。ラスター群は ImageMagick（RSVG デリゲート）で SVG から書き出す。字形やサイズを変えるときは同じ手順で lockup から作り直す。
