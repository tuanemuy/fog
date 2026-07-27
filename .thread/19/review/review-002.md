# PR Review #002 — Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

**PR:** #33
**Date:** 2026-07-28
**Round:** 2回目

## Summary

- Blockers: 34
- Warnings: 28
- Notes: 14
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Domain / Application: `review-002-domain-app.md`（B: 7 / W: 5 / N: 2）
- Cloudflare / Infrastructure: `review-002-cloudflare-infra.md`（B: 4 / W: 5 / N: 3）
- Identity / Security: `review-002-identity-security.md`（B: 9 / W: 7 / N: 3）
- Search / Data / Jobs: `review-002-search-data.md`（B: 6 / W: 5 / N: 4）
- Tests / Spec: `review-002-tests-spec.md`（B: 8 / W: 6 / N: 2）

## 修正方針

- signup の外部 operation ID と canonical user ID を分離し、公開再送を安定化する
- SSO/reset/link/unlink/delete を Account Home 権威の再開可能 saga に統一する
- rotation/reconciler と PITR を実行可能な operator protocol にし、対象と権威を結合する
- semantic RPC を厳密な versioned schema に統一し、topic集合trash・source整合・検索容量制約を実装する
- overdue Alarm、terminal retention、migration、CI offline renderを実環境制約どおり修正する
- 本番 request boundary、identity fault matrix、検索全lifecycle、Alarm fault matrix、機械可読traceabilityを実テストへ移す

すべての Blocker / Warning を今回のスコープ内で修正する。重複指摘は `.thread/19/review/triage.md` の共通キーへ統合する。
