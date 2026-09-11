# fog デザイントークン

`spec/mock.html`（採用済みドラフト）から抽出・体系化したトークン定義。全画面の HTML はここに定義した CSS カスタムプロパティ名をそのまま使う。ハードコード値は使わない。

様式: **ソフトミニマリズム**（浮遊するホワイトシート × ヘアライン罫線 × 単一アクセント）。詳細は [index.md](./index.md) を参照。

## カラー

グレーは青みをわずかに含む冷たいニュートラル（hue ≈ 280）で統一する。彩度を持つ色は Primary（紫）と Accent（橙）の2つだけ。橙はブランドの「点」（ロゴアイコンの点・戻る付きページヘッダーのドット）専用で、面には使わない（ロゴの詳細は [icons/logo.md](./icons/logo.md)）。

```css
:root {
  /* Primary — 操作・リンク・フォーカスの紫
     コントラスト規約（WCAG AA）:
     - アイコン・フォーカスリング・選択マーク（非テキスト 3:1）→ --color-primary
     - 白地上のテキストリンク・テキストボタン → --color-primary-dark（4.7:1）
     - 塗りボタンの背景 → --color-primary-dark（白文字 4.7:1）。ホバーは darker
     - primary-lighter 背景上の文字 → --color-primary-darker（6.0:1） */
  --color-primary-lighter: oklch(0.93 0.04 292); /* #e7e2f8 選択背景・ハイライト */
  --color-primary-light: oklch(0.78 0.09 292);   /* #b9aded */
  --color-primary: oklch(0.63 0.13 292);         /* #8f7ee0 アイコン・フォーカスリング・選択マーク */
  --color-primary-dark: oklch(0.54 0.15 292);    /* #7361c9 テキストリンク・塗りボタン背景 */
  --color-primary-darker: oklch(0.45 0.15 292);  /* #5a49ad アクティブ・lighter 上の文字 */

  /* Accent — ブランドの「点」。面には使わない */
  --color-accent: oklch(0.62 0.19 40);           /* #e8590c ロゴアイコンの点・戻る付きページヘッダーのドットのみ */

  /* Neutral — 青みグレーのスケール */
  --color-neutral-50: oklch(0.97 0.002 286);     /* #f6f6f8 */
  --color-neutral-100: oklch(0.945 0.004 286);   /* #eeeef1 罫線 (--line) */
  --color-neutral-200: oklch(0.93 0.004 286);    /* #e9e9ed ページ背景 */
  --color-neutral-300: oklch(0.875 0.006 278);   /* #d6d7dc アウトライン・ハンドル (--gray) */
  --color-neutral-400: oklch(0.69 0.01 275);     /* #9b9da4 補助テキスト（--text-xs のメタ情報専用。本文・ラベルは 600 以上） */
  --color-neutral-500: oklch(0.58 0.01 275);     /* #7c7e85 アイコン */
  --color-neutral-600: oklch(0.52 0.01 275);     /* #6e7076 弱めの本文・ラベル */
  --color-neutral-700: oklch(0.38 0.008 275);    /* #45464b 引用・二次本文 */
  --color-neutral-900: oklch(0.21 0.006 270);    /* #191a1d 本文 (--ink) */

  /* Semantic — 淡色背景の上に載せる文字は必ず -dark を使う（AA 4.5:1 確保） */
  --color-success: oklch(0.55 0.13 155);         /* #2f9e5f アイコン・白地の短文 */
  --color-success-dark: oklch(0.42 0.11 155);    /* #1e7a45 success-bg 上の文字 */
  --color-success-bg: oklch(0.95 0.03 155);      /* #e3f5ea */
  --color-warning: oklch(0.6 0.13 75);           /* #b07a1e アイコン */
  --color-warning-dark: oklch(0.45 0.1 75);      /* #7d5a12 warning-bg 上の文字 */
  --color-warning-bg: oklch(0.96 0.04 90);       /* #faf3d9 */
  --color-error: oklch(0.55 0.19 27);            /* #d6403a 白地の文字・アイコン */
  --color-error-dark: oklch(0.45 0.19 27);       /* #b02c27 error-bg 上の文字・ホバー */
  --color-error-bg: oklch(0.95 0.025 20);        /* #fbe9e7 */
  --color-info: var(--color-primary);
  --color-info-bg: var(--color-primary-lighter);

  /* Background */
  --color-bg-page: oklch(0.93 0.004 286);        /* #e9e9ed */
  --color-bg-page-top: oklch(0.955 0.003 286);   /* #f0f0f3 ページ上部グラデーション始点 */
  --color-bg-card: oklch(1 0 0);                 /* #ffffff シート・カード */
  --color-bg-section: oklch(0.965 0.9 286 / 0);  /* 使用しない（面の分割は罫線で行う） */
  --color-bg-input: oklch(0.96 0.003 286 / 0.88);/* rgba(244,244,246,.88) コンポーザーの磨りガラス面 */
  --color-bg-hover: oklch(1 0 0 / 0.55);         /* ページ背景上のホバー面（ヘッダーボタン・サイドリンク） */
  --color-overlay: oklch(0.21 0.006 270 / 0.28); /* モーダル・ナビシートのオーバーレイ */
  --gradient-page: linear-gradient(180deg, var(--color-bg-page-top) 0%, var(--color-bg-page) 240px);
                                                 /* body に敷くページ背景（上 240px で page-top から page へ） */

  /* Text on fill */
  --color-text-inverse: oklch(1 0 0);            /* 塗りボタン・トースト上の白文字 */

  /* Focus — リングは2色のみ。通常は紫、破壊的操作ボタンだけ赤（意図的なセマンティック差） */
  --color-focus: var(--color-primary);
  --color-focus-danger: var(--color-error);      /* 削除・完全削除・空にする等の実行ボタン専用 */
}
```

補足:
- `--color-bg-section` は様式上使わない（面の階層は背景×シートの2段まで。シート内の区切りは `--color-neutral-100` の1pxヘアラインで行う）
- 磨りガラス面はコンポーザーだけで、`--color-bg-input` + `backdrop-filter: blur(var(--blur-glass))`。ボトムシートナビは `--color-bg-card` の白いカード

## タイポグラフィ

UI 基本書体は OS 標準のサンセリフスタック1本。Web フォントは読み込まない（普遍的な書体で、読み込み遅延・FOUT をなくす）。見出し書体は分けない（様式上、階層はサイズとウェイトのみで表現する）。等幅は日時・残日数など数値表示のタブラー表示に `font-variant-numeric: tabular-nums` を使い、専用モノスペース書体は導入しない。

唯一の例外が `--font-brand` — ロゴの Wordmark（Avenir Next）に揃えるブランド書体で、戻る付きページヘッダーの短い英語タイトル専用。Apple プラットフォーム以外では Helvetica にフォールバックし、字形の完全一致は求めない（ロゴ本体はアウトライン化した SVG で固定されている。[icons/logo.md](./icons/logo.md) 参照）。

```css
:root {
  --font-base: "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN",
    "Hiragino Sans", "Noto Sans JP", sans-serif;
  --font-brand: "Avenir Next", "Avenir", "Helvetica Neue", Arial, sans-serif;

  --text-xs: 0.72rem;                             /* メタ情報（日時・残日数） */
  --text-sm: 0.78rem;                             /* 補助説明・ラベル */
  --text-base: 0.95rem;                           /* 本文・メモテキスト */
  --text-lg: 1.05rem;                             /* 画面タイトル（ヘッダー） */
  --text-xl: clamp(1.2rem, 1.1rem + 0.5vw, 1.45rem);  /* ドキュメントタイトル */
  --text-2xl: clamp(1.45rem, 1.3rem + 0.8vw, 1.8rem); /* 認証画面等の大見出し */

  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;

  --leading-tight: 1.5;                           /* 見出し */
  --leading-normal: 1.85;                         /* 本文・メモ */
  --leading-loose: 2;                             /* ドキュメント本文 */

  --tracking-label: 0.03em;                       /* 時刻ラベル等の小さな英数字 */
}
```

ウェイトの役割: 本文=400 / 項目名・ボタン=500 / 画面タイトル=600 / ドキュメントタイトル・h2=700。読ませるテキスト（メモ・ドキュメント）は 400 のまま行間で読みやすさを作る。

## スペーシング

基準 4px。シート内の縦リズムは罫線区切りの行（縦 padding 14〜18px）が基本単位。テキストとヘアラインはコンテンツカラム幅に揃え、インタラクティブ行のホバー/フォーカス面だけが左右へ `--space-md` 張り出す（負マージンの唯一の例外。[index.md](./index.md) の「行のホバー面」「負マージンは原則禁止」参照）。

```css
:root {
  --space-xs: 0.25rem;   /* 4px */
  --space-sm: 0.5rem;    /* 8px */
  --space-md: 0.875rem;  /* 14px 行間ギャップ・シート左右マージン */
  --space-lg: 1.5rem;    /* 24px シート内側パディング */
  --space-xl: 1.875rem;  /* 30px シート上部パディング */
  --space-2xl: 2.5rem;   /* 40px */
  --space-section: 2.25rem; /* 36px シート内セクション間（.origin 等） */
  --space-sheet-end: 5rem;  /* 80px シート内側の下端（スクロールの終わり際の逃げ幅） */
  --space-sheet-end-composer: 9.375rem; /* 150px コンポーザーを持つ画面のシート内側の下端 */

  /* 画面端に接する余白 — 既定の段と「safe-area + 1段下」の大きいほう。
     viewport-fit=cover でノッチ・ホームインジケータ帯に食い込まないようにする */
  --space-safe-t-lg: max(var(--space-lg), calc(env(safe-area-inset-top, 0px) + var(--space-md)));
                         /* ヘッダーの上端 */
  --space-safe-b-xl: max(var(--space-xl), calc(env(safe-area-inset-bottom, 0px) + var(--space-md)));
                         /* コンポーザーの下端 */
  --space-safe-b-2xl: max(var(--space-2xl), calc(env(safe-area-inset-bottom, 0px) + var(--space-lg)));
                         /* ボトムシートの下端 */

  /* コンポーネント余白 — 役割で選ぶ */
  --pad-row: 16px;       /* リスト行の縦 padding（全画面共通） */
  --pad-menu: 0.75rem var(--space-md); /* 12px 14px メニュー/ナビ項目（サイドバーリンク・ポップオーバー項目） */
  --pad-btn: 12px 24px;  /* ピルボタン大（フォームの主ボタン） */
  --pad-btn-sm: 10px 20px; /* ピルボタン小（ヘッダー保存・インライン追加・設定行のボタン） */
  --pad-input: 12px 16px; /* 入力欄（フォームの入力・コンポーザー・検索欄・日付と数値の入力） */
}
```

### 余白の向き

縦の余白は必ず**上に付ける**。同じ間隔を下から付けたり上から付けたりが混ざると、隣り合った要素の余白が相殺したり二重になったりして、値を見ても実際の間隔がわからなくなる。優先順は次の3段階。

1. **等間隔の並びはコンテナの `gap`** — 親が余白を持ち、子は縦余白を一切持たない。要素を並べ替えても間隔が崩れない。
2. **間隔が不揃いな流れは次の要素の `margin-top`** — 「自分の前に空ける」という自己完結した宣言なので、要素を別の場所へ移しても壊れない。ラベルと本体のような組は `.ラベル + * { margin-top: … }` と書き、ラベル単体を別の文脈で使ったときに余白が付いてこないようにする。
3. **`margin-bottom` と `margin: X 0` は使わない** — 最後の子の下余白はコンテナの `padding-bottom` に足されるので、上下同じ padding を指定しても下だけ広く見える。

`margin: 0 auto 14px` のような shorthand も下余白なので同じ扱い。水平センタリングだけ残して `margin: 0 auto` + 次要素の `margin-top` に分ける。

例外は「余白の担い手を動かせない」2つだけ。どちらもコメント付きで `margin-bottom` を残している。

- **表示/非表示が切り替わる要素** — `display: none` で閉じる要素は下余白なら一緒に消えるが、`+ *` の上余白は閉じていても残る。timeline の `.filter-bar`。
- **`em` で余白を持つ要素** — `em` は余白を持つ要素の `font-size` で解決されるので、次要素へ移すと基準が変わって値が保存されない。document の `.doc-body h2`（見出し基準 15.1px が本文基準 13.7px になる）。

なお `padding` は「区切り」と「箱の内側」の二義があるため、`.inner > *:first-child` のようなエリア一括指定はできない。区切りとしての上 padding を先頭で殺す場合は `.section-head:first-child` のようにクラス名指しで書く。

## ブレークポイント

標準ブレークポイント。モバイルファーストで、メディアクエリでは数値リテラルを使う。

| 名前 | 最小幅 | メディアクエリ |
|------|--------|----------------|
| (base) | 0 | （未指定・モバイル基準） |
| `sm` | 640px | `@media (min-width: 640px)` |
| `md` | 768px | `@media (min-width: 768px)` |
| `lg` | 1024px | `@media (min-width: 1024px)` |
| `xl` | 1280px | `@media (min-width: 1280px)` |
| `2xl` | 1536px | `@media (min-width: 1536px)` |

```css
:root {
  --bp-sm: 640px;
  --bp-md: 768px;
  --bp-lg: 1024px;
  --bp-xl: 1280px;
  --bp-2xl: 1536px;
}
```

## その他

```css
:root {
  /* Border Radius */
  --radius-sm: 0.375rem;   /* 6px フォーカスリング角・小要素 */
  --radius-md: 0.625rem;   /* 10px 行フォーカス・入力欄 */
  --radius-popover: 0.875rem; /* 14px ポップオーバーメニュー */
  --radius-lg: 1.625rem;   /* 26px シート・ナビシート */
  --radius-full: 9999px;   /* ピル・コンポーザー・ボタン */

  /* Border */
  --border-input: 1.3px solid var(--color-neutral-300); /* 入力欄の枠線（ヘアラインよりわずかに強い） */

  /* Icon — サイズは4段のみ。ストロークは 1.5〜1.8px の線画 */
  --icon-lg: 20px;         /* 戻る矢印 */
  --icon-md: 19px;         /* ヘッダー操作・行末操作（ジャンプ/復元/削除） */
  --icon-sm: 16px;         /* 行内トリガー(…)・ポップオーバー項目・× 閉じる */
  --icon-xs: 12px;         /* テキストに随伴する小グリフ（リンク矢印・+ 等） */

  /* Popover */
  --popover-min-w: 10rem;  /* 160px ポップオーバー最小幅 */

  /* 点・ハンドル — 面ではなく「点」として置く小さな図形 */
  --size-dot: 6px;         /* ブランドの点（戻る付きヘッダー）・ナビの現在地マーク */
  --size-handle-w: 36px;   /* ボトムシートのハンドル */
  --size-handle-h: 4px;

  /* Blur */
  --blur-glass: 16px;      /* 磨りガラス面（コンポーザー）の backdrop-filter */

  /* Shadow — 影は「浮遊」の表現専用。3段のみ */
  --shadow-sm: 0 2px 24px oklch(0.21 0.006 270 / 0.05);   /* シート */
  --shadow-md: 0 12px 36px oklch(0.21 0.006 270 / 0.18);  /* コンポーザー・フローティング要素 */
  --shadow-lg: 0 -8px 40px oklch(0.21 0.006 270 / 0.2);   /* ボトムシート */

  /* Transition — 2種のみ。どちらも ease。持続時間とイージングを成分として持ち、
     shorthand はその合成（ユーティリティは成分を別々に読む） */
  --duration-fast: 0.15s;
  --duration-default: 0.22s;
  --ease-default: ease;
  --transition-fast: var(--duration-fast) var(--ease-default);
  --transition-default: var(--duration-default) var(--ease-default);

  /* Container */
  --container-max: 1280px;
  --content-max: 50rem;        /* 800px シート内コンテンツの最大幅（全画面共通） */
  --sheet-max: calc(var(--content-max) + 2 * var(--space-2xl));
                               /* 880px ヘッダーとシートが共有する横フレームの最大幅 */
  --sheet-w: min(100% - 2 * var(--space-md), var(--sheet-max));
                               /* 横フレームの幅（md 未満）。余った幅はページ背景へ逃がす */
  --sheet-w-md: min(100% - 2 * var(--space-lg), var(--sheet-max));
                               /* 横フレームの幅（md 以上） */
  --nav-sheet-inset: max(var(--space-md), calc((100% - var(--sheet-max)) / 2));
                               /* ボトムシートの左右位置（横フレームに揃える） */
  --narrow-max: 26rem;         /* 416px 単一カラムの狭いカード（認証シート・確認ダイアログ・コンポーザー） */
  --input-number-w: 6.5rem;    /* 104px 数値入力（4桁）の幅 */
  --container-padding: clamp(0.875rem, 4vw, 2rem);
  --sidebar-w: 200px;          /* lg 以上の常設サイドバー幅 */

}
```

- `prefers-reduced-motion: reduce` では transition を無効化する（全画面共通）
- フォーカスリングは `outline: 2px solid var(--color-primary); outline-offset: 2px;`（行内要素は `-2px` + `--radius-md`）

## フォント読み込み

Web フォントは使わない。`--font-base` の OS 標準スタックのみで、`<link>` による外部フォント読み込み（Google Fonts 等）は全ページで行わない。

## 実装への写し

`apps/web/app/styles/tokens.css` は、この文書のコードブロックの写しで、名前と値が一致する。生の値を持つのは `tokens.css` だけで、ほかの CSS と、Tailwind がアプリのソースから生成するユーティリティは、トークンと下の許容リストの値だけを使う。`lint/designTokens.test.ts` がこの一致と、生の値・未定義の参照・`var()` のフォールバックが無いことを検査する。

## モックの生の値の選別

`pages/*.html` のうち、トークンを通らない値を 1 つずつ (a) 既存トークンへ寄せる / (b) 新しい役割のトークンを足す、に分けた結果。寄せた箇所はモックと px では一致しない（「同形」は構造の一致で、px の一致ではない）。アイコン 4 段・影 3 段・トランジション 2 種には段を足さず、寄せるだけにする。モック HTML は書き換えない。

### (b) 足したトークン

| トークン | モックの値 | 役割 |
|---|---|---|
| `--gradient-page` | 全画面の `body` の `linear-gradient(180deg, … 240px)` | ページ背景 |
| `--space-sheet-end` / `--space-sheet-end-composer` | `.inner` の下 `80px` / `150px` | シート内側の下端の逃げ幅（[index.md](./index.md)「余白と区切り」） |
| `--space-safe-t-lg` / `--space-safe-b-xl` / `--space-safe-b-2xl` | `header.top` の `max(20px, env(…) + 12px)`、`.composer-wrap` の `max(30px, env(…) + 16px)`、`.nav-sheet` の `max(40px, env(…) + 24px)` | 画面端に接する余白。既定値と safe-area の加算分をスケールの段へ寄せた |
| `--pad-input` | `.form-input` などの `12px 16px` | 入力欄の内側余白 |
| `--size-dot` | `.h-title .dot` の `6px` | ブランドの点 |
| `--size-handle-w` / `--size-handle-h` | `.nav-sheet .handle` の `36px` × `4px` | ボトムシートのハンドル |
| `--blur-glass` | `.composer` の `blur(16px)` | 磨りガラス面 |
| `--sheet-w` / `--sheet-w-md` / `--nav-sheet-inset` | `.sheet`・`.nav-sheet` のトークンの式 | ヘッダー・シート・ボトムシートが共有する横フレーム |
| `--narrow-max` | `.auth-sheet` の `26rem` | 単一カラムの狭いカード |
| `--input-number-w` | `.input-number` の `6.5rem` | 数値入力の幅 |
| `--duration-*` / `--ease-default` | （`--transition-*` の成分） | 2 種のトランジションを、持続時間とイージングに分けて読むため。段は増えない |

### (a) 寄せた値

余白（`gap`・`padding`・`margin`）は軸ごとに一番近い段へ寄せ、等距離なら小さい段を取る: 2〜6px → `--space-xs`、8〜10px → `--space-sm`、12〜18px → `--space-md`、20〜24px → `--space-lg`、28〜30px → `--space-xl`、40px → `--space-2xl`。役割のトークンがある箱（入力欄・ボタン・行・メニュー項目）はそちらを使う。

| モックの値（主な箇所） | 寄せ先 |
|---|---|
| `.composer` `14px 20px`、`.search-box` `16px 20px`、`.date-input` / `.input-number` `10px 12px` | `--pad-input` |
| `.dialog-btn` `12px 16px` | `--pad-btn-sm` |
| `.nav-item` の横 `2px` | `--space-xs`（縦は `--pad-row` のまま） |
| `.doc-body li` / `.memo-list li` の `padding-left: 18px` | `--space-md` |
| `.day-head .sub` の `margin-left: 8px` | 親の `gap` の `--space-sm` |
| `.menu-popup` の `top: calc(100% + 6px)`、`.topic-pop` の `calc(100% - 12px)`、`.entry-pop` の `top: 28px` | トリガーの下端（`100%`）＋余白の段 |
| `.nav-item .mark` / `.side-link .mark` の `5px` | `--size-dot` |
| `.nav-sheet .handle` の `border-radius: 4px` | `--radius-full` |
| `.menu`（ハンバーガー）の線 `19px` / `12px` × `2.5px`・角丸 `3px`・間隔 `6px` | アイコン（線画）の `--icon-md` |
| `.spinner` の `14px`・`border: 2px` | アイコン（線画）の `--icon-xs`。線の太さは SVG が持つ |
| `.restriction-icon` `18px`、`.scope-icon` `20px` | `--icon-md` |
| `.diff-mark` の `width: 16px` | `--icon-sm` |
| `.restriction-icon` の `margin-top: 2px` | アイコンを文字の 1 行目に揃える `1lh` の箱（`.inline-alert svg` と同形） |
| 行の操作ボタン（`.row-action` など）の `28px` 四方 | アイコン＋`--space-xs` の padding |
| `.dialog-box` `320px`、`.composer` `340px` / `420px` | `--narrow-max` |
| `.dialog-cancel` の `1.3px solid neutral-100` | `--border-input` |
| `.doc-row .d-name` の `line-height: 1.6` / `.origin-row .o-text` の `1.8` | `--leading-tight` / `--leading-normal` |
| `.body-input` の `min-height: 10em` | `10lh`（行数で数える） |
| SVG の `18` / `15` / `14` / `10` と、行末の復元・削除の `20` | `--icon-md` / `--icon-sm` / `--icon-xs` / `--icon-xs` / `--icon-md` |

ロゴ（lockup）の表示寸法は [icons/logo.md](./icons/logo.md) が決め、SVG の属性で持つ。

### 消した値（実装だけにあったトークン）

- 読み込み中のバーの寸法: スケルトンは実画面の DOM に被せる形で、固有の寸法を持たない
- ヘッダー以外の上端の safe-area の段: 使う箇所が無い
- ナビの現在地マークの寸法: `--size-dot` へ寄せた

## 許容リスト

`tokens.css` の外の CSS と生成されたユーティリティに、生の値として現れてよいもの。これ以外の色・長さ・書体・文字サイズ・ウェイト・行間・字間・角丸・影・トランジションは、トークンかその投影から来る。

- `0`（単位の有無を問わない）
- `1px` と `-1px`（ヘアライン）
- `2px` と `-2px`（フォーカスリングの `outline` と `outline-offset` だけ）
- ブレークポイントの値（上の表の 5 つ。`theme.css` の `--breakpoint-*` と、`@media` の条件だけ）
- 相対単位: `%`・ビューポート単位（`vw`・`vh`・`dvh` など）・`fr`・`lh`（行数で数える寸法。1 行の高さは行間トークンから決まる）
- `em`（`margin` だけ。「余白の向き」の例外）
- `@keyframes` の中身と、それを使う `--animate-*`（スピナーの回転。アニメーションはこれだけ）
- 値を選ばないキーワード: `transparent`・`currentColor`・`none`・`inherit` などの CSS 全体キーワード。スケルトンの透明な文字と、塗りの無い面に使う

角度（`rotate`・グラデーションの向き）と、単位の無い倍率（`calc` の係数・`z-index`・`opacity` など）は上の区分に入らない。モック HTML と、TSX の `style` 属性は検査の対象外。
