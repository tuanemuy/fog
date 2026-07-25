# PR Review #003 — design: 縦余白を上向きに統一し mb-* を排除

**PR:** #32
**Date:** 2026-07-26
**Round:** 3回目

## Summary

- Blockers: 0
- Warnings: 3
- Notes: 9
- Verdict: **BLOCKED**（Warning 3 件を fix と仕分けたため）

## レイヤー別ファイル

- General Review: review-003-general.md（B: 0 / W: 3）

## 指摘一覧

- [W-001] JSDoc の不変条件が実際より広く、`.form-links` の `mt-section` が違反に見える — `apps/web/app/components/ui/AuthSheet/index.tsx:16-19`（General）
- [W-002] JSDoc と JSX コメントが flex を選んだ理由を互いに逆向きに説明している — `apps/web/app/components/ui/AuthSheet/index.tsx:36-38`（General）
- [W-003] PR 本文の Summary が R1 で撤回した案を指したまま — PR #32 本文（General）

## 仕分け

fix: W-001 / W-002 / W-003

前ラウンドまでに決着済みの Key の再提出はなし。
