# fog デザイントークン

`spec/mock.html`（採用済みドラフト）から抽出・体系化したトークン定義。全画面の HTML はここに定義した CSS カスタムプロパティ名をそのまま使う。ハードコード値は使わない。

様式: **ソフトミニマリズム**（浮遊するホワイトシート × ヘアライン罫線 × 単一アクセント）。詳細は [index.md](./index.md) を参照。

## カラー

グレーは青みをわずかに含む冷たいニュートラル（hue ≈ 280）で統一する。彩度を持つ色は Primary（紫）と Accent（橙）の2つだけ。橙はブランドの「点」（ヘッダーのドット）専用で、面には使わない。

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
  --color-accent: oklch(0.62 0.19 40);           /* #e8590c ヘッダードットのみ */

  /* Neutral — 青みグレーのスケール */
  --color-neutral-50: oklch(0.97 0.002 286);     /* #f6f6f8 */
  --color-neutral-100: oklch(0.945 0.004 286);   /* #eeeef1 罫線 (--line) */
  --color-neutral-200: oklch(0.93 0.004 286);    /* #e9e9ed ページ背景 */
  --color-neutral-300: oklch(0.875 0.006 278);   /* #d6d7dc アウトライン・ハンドル (--gray) */
  --color-neutral-400: oklch(0.69 0.01 275);     /* #9b9da4 補助テキスト (--sub) */
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
  --color-bg-input: oklch(0.96 0.003 286 / 0.88);/* rgba(244,244,246,.88) コンポーザー等の磨りガラス面 */
  --color-bg-hover: oklch(1 0 0 / 0.55);         /* ページ背景上のホバー面（ヘッダーボタン・サイドリンク） */
  --color-overlay: oklch(0.21 0.006 270 / 0.28); /* モーダル・ナビシートのオーバーレイ */

  /* Text on fill */
  --color-text-inverse: oklch(1 0 0);            /* 塗りボタン・トースト上の白文字 */

  /* Focus — リングは2色のみ。通常は紫、破壊的操作ボタンだけ赤（意図的なセマンティック差） */
  --color-focus: var(--color-primary);
  --color-focus-danger: var(--color-error);      /* 削除・完全削除・空にする等の実行ボタン専用 */
}
```

補足:
- `--color-bg-section` は様式上使わない（面の階層は背景×シートの2段まで。シート内の区切りは `--color-neutral-100` の1pxヘアラインで行う）
- 磨りガラス面（コンポーザー・シートナビ）は `--color-bg-input` + `backdrop-filter: blur(16px)`

## タイポグラフィ

UI 基本書体は OS 標準のサンセリフスタック1本。Web フォントは読み込まない（普遍的な書体で、読み込み遅延・FOUT をなくす）。見出し書体は分けない（様式上、階層はサイズとウェイトのみで表現する）。等幅は日時・残日数など数値表示のタブラー表示に `font-variant-numeric: tabular-nums` を使い、専用モノスペース書体は導入しない。

```css
:root {
  --font-base: "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN",
    "Hiragino Sans", "Noto Sans JP", sans-serif;

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

  /* コンポーネント余白 — 役割で選ぶ */
  --pad-row: 16px;       /* リスト行の縦 padding（全画面共通） */
  --pad-menu: 0.75rem var(--space-md); /* 12px 14px メニュー/ナビ項目（サイドバーリンク・ポップオーバー項目） */
  --pad-btn: 12px 24px;  /* ピルボタン大（フォームの主ボタン） */
  --pad-btn-sm: 10px 20px; /* ピルボタン小（ヘッダー保存・インライン追加・設定行のボタン） */
}
```

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

  /* Shadow — 影は「浮遊」の表現専用。3段のみ */
  --shadow-sm: 0 2px 24px oklch(0.21 0.006 270 / 0.05);   /* シート */
  --shadow-md: 0 12px 36px oklch(0.21 0.006 270 / 0.18);  /* コンポーザー・フローティング要素 */
  --shadow-lg: 0 -8px 40px oklch(0.21 0.006 270 / 0.2);   /* ボトムシート */

  /* Transition */
  --transition-fast: 0.15s ease;
  --transition-default: 0.22s ease;

  /* Container */
  --container-max: 1280px;
  --content-max: 50rem;        /* 800px シート内コンテンツの最大幅（全画面共通） */
  --sheet-max: calc(var(--content-max) + 2 * var(--space-2xl));
                               /* 880px ヘッダーとシートが共有する横フレームの最大幅 */
  --container-padding: clamp(0.875rem, 4vw, 2rem);
  --sidebar-w: 200px;          /* lg 以上の常設サイドバー幅 */

}
```

- `prefers-reduced-motion: reduce` では transition を無効化する（全画面共通）
- フォーカスリングは `outline: 2px solid var(--color-primary); outline-offset: 2px;`（行内要素は `-2px` + `--radius-md`）

## フォント読み込み

Web フォントは使わない。`--font-base` の OS 標準スタックのみで、`<link>` による外部フォント読み込み（Google Fonts 等）は全ページで行わない。
