# PR Review #004 — Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

**PR:** #33
**Date:** 2026-07-28
**Round:** 4回目

## Summary

- Blockers: 16
- Warnings: 9
- Notes: 7
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Identity / Domain: `review-004-identity-domain.md`（B: 5 / W: 2 / N: 2）
- Search / Data / Jobs: `review-004-search-data.md`（B: 5 / W: 3 / N: 2）
- Infra / Tests: `review-004-infra-tests.md`（B: 6 / W: 4 / N: 3）

## 修正方針

- logical credential authorityから物理locatorを隠し、domain aggregateを本番判断の権威へする
- reset mailを実行可能なpersistent jobへし、credential PIIを暗号化・期限削除する
- semantic capability/OCC/revision/AI provenanceとtopic削除後restoreをspecへ一致させる
- PITR receipt往復、両class evidence、rotation zero-reference、production entry acceptanceを実証する
- traceabilityを実行report/HEAD/CI conclusionに結び付ける

すべての Blocker / Warning を修正対象とする。
