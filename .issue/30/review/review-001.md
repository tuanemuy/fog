# PR Review #001 — design: 縦余白を上向きに統一し mb-* を排除

**PR:** #32
**Date:** 2026-07-26
**Round:** 1回目

## Summary

- Blockers: 0
- Warnings: 5
- Notes: 9
- Verdict: **BLOCKED**（Warning 4 件を fix と仕分けたため）

## レイヤー別ファイル

- General Review: review-001-general.md（B: 0 / W: 5）

## 指摘一覧

- [W-001] children ラッパーが素のブロック要素でマージン相殺の罠を新設 — `apps/web/app/components/ui/AuthSheet/index.tsx:31`（General）
- [W-002] ナビシート先頭項目の余白アンカーが設計の `.handle + *` とずれている — `apps/web/app/components/layout/AppShell/index.tsx:197-199`（General）
- [W-003] `SettingsSkeleton` と `CurrentUserPanel` の同期が必要な約束が増えたが守る仕組みがない — `apps/web/app/components/settings/SettingsSkeleton/index.tsx:3`（General）
- [W-004] ラッパー `<div className="mt-section">` の存在理由がコードから読めない — `apps/web/app/components/ui/AuthSheet/index.tsx:31`（General）
- [W-005] 設定の見出し下が 8px のままで設計の 12px と乖離 — `apps/web/app/components/settings/CurrentUserPanel/index.tsx:33`（General）

## 仕分け

fix: W-001 / W-002 / W-003 / W-004
defer: W-005（Phase 5 で別 Issue 起票）
