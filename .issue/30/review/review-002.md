# PR Review #002 — design: 縦余白を上向きに統一し mb-* を排除

**PR:** #32
**Date:** 2026-07-26
**Round:** 2回目

## Summary

- Blockers: 0
- Warnings: 4
- Notes: 8
- Verdict: **BLOCKED**（Warning 4 件を fix と仕分けたため）

## レイヤー別ファイル

- General Review: review-002-general.md（B: 0 / W: 4）

## 指摘一覧

- [W-001] children が上余白を持たない不変条件が JSDoc（利用側から見える場所）にない — `apps/web/app/components/ui/AuthSheet/index.tsx:10-15`（General）
- [W-002] 追加コメントがマージン相殺の挙動を逆に説明している／件数・px のハードコード — `apps/web/app/components/ui/AuthSheet/index.tsx:31-33`（General）
- [W-003] 2 コミット目の変更が adr.md / plan.md に未反映 — `.issue/30/adr.md:21` / `.issue/30/plan.md:99,117`（General）
- [W-004] `AppShell` が設計 HTML から意図的にずれている理由がコードから辿れない — `apps/web/app/components/layout/AppShell/index.tsx:84-90`（General）

## 仕分け

fix: W-001 / W-002 / W-003 / W-004
wont-fix: W-003 のうち ADR Status を `Accepted` に倒す提案（`.issue/1/adr.md` は全 ADR が `Proposed` のままで、リポジトリの慣習に合わせる）

前ラウンドで決着済みの 5 Key の再提出はなし。
