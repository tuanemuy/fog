# 指摘台帳 — Issue #30 / PR #32

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `AuthSheet/index.tsx:children ラッパー/マージン相殺` | R1 | fix | flex コンテナにすれば相殺の罠が構造的に消え、設計の `.auth-form` とも形が一致する | 0 |
| `AppShell/index.tsx:ナビシート先頭項目/余白のアンカー` | R1 | fix | 設計の `.handle + *` と同じアンカーに戻し、境界線の分岐と直交させる | 0 |
| `SettingsSkeleton/index.tsx:ROW 定数/実 DOM との同期` | R1 | fix | 共有定数の抽出はスコープ外だが、対で維持する不変条件を JSDoc に明記する（CLAUDE.md のコメント方針に合致） | 0 |
| `AuthSheet/index.tsx:children ラッパー/存在理由のコメント` | R1 | fix | ADR-001 の理由がコードから辿れない。CLAUDE.md の「WHY が非自明なときだけ書く」条件に合致 | 0 |
| `CurrentUserPanel/index.tsx:見出し下の余白/設計値との乖離` | R1 | defer | Issue #30 が明示的に `mt-sm` を指示しており値の変更はスコープ外。設計 12px との乖離は Phase 5 で別 Issue 化 | 0 |
