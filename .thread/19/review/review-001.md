# PR Review #001 — Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

**PR:** #33
**Date:** 2026-07-28
**Round:** 1回目

## Summary

- Blockers: 38
- Warnings: 20
- Notes: 12
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Domain / Application: `review-001-domain-app.md`（B: 7 / W: 3）
- Cloudflare / Infrastructure: `review-001-cloudflare-infra.md`（B: 6 / W: 4）
- Identity / Security: `review-001-identity-security.md`（B: 8 / W: 5）
- Search / Data: `review-001-search-data.md`（B: 10 / W: 5）
- Tests / Spec: `review-001-tests-spec.md`（B: 7 / W: 3）

## 指摘一覧

- identity coordinator、stable operation、authority/epoch、SSO/reset/link/unlink/delete、rotation/reconciler、RPC envelopeをapplication contractとして完成させる
- semantic lifecycle、idempotency conflict、revision/source/topic/trash、検索DTO・順位・snippet・pagination・typed errorをspecどおり完成させる
- Alarm starvation、job executor/lease/poison、migration、PITR operator toolingを実装する
- CI、2 Worker境界、manual CLI、legacy audit、受け入れtraceabilityを実テストへ移す
- performance/型/secret validation/current-user projection/clockのWarningsも同じ修正ラウンドで解消する

