# ADR — Issue #30: デザインの余白ルール（縦余白は上に付ける）を実装に反映する

## ADR-001: `AuthSheet` の children は内部でラップして上余白を持たせる

### Status

Proposed

### Context

設計側（`spec/design/pages/{login,signup,password-reset}.html`）は `.auth-form { margin-top: var(--space-section) }` で「本文側が自分の上余白を宣言する」形を取っている。実装では本文が `AuthSheet` の `children` として外から渡されており、その形は 5 箇所で不揃い:

- `routes/login.tsx` / `routes/signup.tsx` — `<form className="flex flex-col gap-lg">`
- `routes/password-reset.tsx` — `<div className="text-center text-sm">`
- `routes/__root.tsx` notFound — `<p className="text-center text-sm">`
- `routes/__root.tsx` ErrorScreen — `<ErrorRetry fullWidth />`（`className` を受け取らない）

選択肢は 2 つ。

1. 利用側 5 箇所それぞれに `mt-section` を付ける（設計の CSS と 1:1）
2. `AuthSheet` が `{children}` をラッパーの `<div>` で包み、そこに `mt-section` を持たせる

### Decision

2 を選ぶ。`ErrorRetry` は `className` を受け取らないため 1 は API 追加なしには成立せず、成立させたとしても「シート内の縦リズム」という `AuthSheet` の内部事情が利用側 5 箇所に漏れる。付け忘れれば余白が黙って消える種類の漏れなので、シートが持ち切るほうが壊れにくい。

ラッパーは `<div className="mt-section flex flex-col">` とする。裸のブロックにすると、children 先頭が `mt-*` を宣言したときに親子マージン相殺が起きてラッパーの `mt-section` と融合し、シートの余白が children の中身に左右されてしまう（相殺の結果は `max(--space-section, 子の値)` で、消えるのは小さいほう＝和にはならない）。flex コンテナは子とマージン相殺しないので、ラッパーの余白は children の形に関わらず保存される。

設計 CSS との 1:1 対応は崩れるが、余白の**向き**（上に付ける）と**値**（`--space-section`）は保存される。本 Issue が反映するのは向きのルールであって、セレクタの形ではない。

### Consequences

- 良い点: 利用側は本文を渡すだけでよく、新しい pre-auth 画面を足しても余白が自動で揃う。`ErrorRetry` に `className` を生やさずに済む
- トレードオフ: DOM ノードが 1 段増える。`ErrorRetry fullWidth` のようにブロック幅を前提とする子は、ラッパー越しでも意図どおり広がることを実機で確認する必要がある
- トレードオフ: flex 化で相殺は止まるが、その代わり children 先頭の `mt-*` はラッパーの `mt-section` に**加算**される。「children は上余白を持たない」という約束が必要になるので、`AuthSheet` の JSDoc（= 利用側から見える唯一の説明）に不変条件として明記し、設計 HTML の `.auth-form { margin-top }` を実装側で落としていることを `LoginForm` / `SignupForm` にもコメントで残す
- 注意: ラッパーは裸の `<div>` に見えるが、`mt-section` の担い手であり相殺を止める役目も持つ。不要と判断して外すと余白が children 依存になる

---

## ADR-002: サイドバーのブランド下の余白は `<nav>` の `mt-2xl` に移す

### Status

Proposed

### Context

`AppShell` のサイドバーのブランドは現在 `<BrandLink className="mb-2xl px-md …">`。設計側（`spec/design/pages/timeline.html`）は `.brand { padding: 0 var(--space-md) var(--space-2xl) }` と **padding** で持っており、`padding` は本ルールの対象外なので、設計に忠実に寄せるなら `px-md pb-2xl` でも「`mb-*` を残さない」という完了条件は満たせる。

ただし `BrandLink` はリンク要素であり、`padding-bottom` はクリック領域を 40px 下方向に広げる。現状の `margin-bottom` は広げないため、`pb-2xl` にすると余白の見た目は同じままクリック領域だけが変わる。

### Decision

Issue のチェックリストどおり、`BrandLink` から `mb-2xl` を削除し、直後の `<nav>` に `mt-2xl` を付ける。

理由は 2 つ。(1) 現状の当たり判定が保存され、本 Issue が「余白の向きの反映」だけに閉じる。(2) `margin-top` は「前を空ける」以外の意味を持たないため、`padding` の二義性（区切り / 箱の内側）を持ち込まずに済む。

### Consequences

- 良い点: 見た目・当たり判定とも変更前と一致し、`mb-*` の完全排除という完了条件も満たす
- トレードオフ: 設計 HTML の `.brand` は padding のままなので、CSS の書き方としては実装と設計が 1:1 でなくなる。間隔の値（40px）と向き（上）は一致する

---
