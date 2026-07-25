# 指摘台帳 — Issue #30 / PR #32

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `AuthSheet/index.tsx:children ラッパー/マージン相殺` | R1 | fix | flex コンテナにすれば相殺の罠が構造的に消え、設計の `.auth-form` とも形が一致する | 0 |
| `AppShell/index.tsx:ナビシート先頭項目/余白のアンカー` | R1 | fix | 設計の `.handle + *` と同じアンカーに戻し、境界線の分岐と直交させる | 0 |
| `SettingsSkeleton/index.tsx:ROW 定数/実 DOM との同期` | R1 | fix | 共有定数の抽出はスコープ外だが、対で維持する不変条件を JSDoc に明記する（CLAUDE.md のコメント方針に合致） | 0 |
| `AuthSheet/index.tsx:children ラッパー/存在理由のコメント` | R1 | fix | ADR-001 の理由がコードから辿れない。CLAUDE.md の「WHY が非自明なときだけ書く」条件に合致 | 0 |
| `CurrentUserPanel/index.tsx:見出し下の余白/設計値との乖離` | R1 | defer | Issue #30 が明示的に `mt-sm` を指示しており値の変更はスコープ外。設計 12px との乖離は Phase 5 で別 Issue 化 | 0 |
| `AuthSheet/index.tsx:JSDoc/children は上余白を持たない不変条件` | R2 | fix | flex 化で失敗モードが「二重計上」に変わった。破るのは利用側なので JSDoc に置く | 0 |
| `AuthSheet/index.tsx:ラッパーのコメント/相殺の説明が不正確` | R2 | fix | 相殺で消えるのは子側。誤った説明は書かないより悪い。件数・px のハードコードも落とす | 0 |
| `.issue/30/adr.md・plan.md:記録/実装との食い違い` | R2 | fix | ADR-001 の Decision が flex 化前のまま、plan.md のリスク節が現実装と正反対 | 0 |
| `.issue/30/adr.md:Status/Proposed のまま` | R2 | wont-fix | `.issue/1/adr.md` は全 ADR が `Proposed` のまま。リポジトリの慣習に合わせる | 0 |
| `AppShell/index.tsx:BrandLink/設計と違う形にした理由` | R2 | fix | `pb-2xl` に戻すと当たり判定が黙って 40px 広がる。R1 W-004 と同じ構図で扱いを揃える | 0 |
