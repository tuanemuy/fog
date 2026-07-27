# PR Review #003 — Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

**PR:** #33
**Date:** 2026-07-28
**Round:** 3回目

## Summary

- Blockers: 37
- Warnings: 20
- Notes: 13
- Verdict: **BLOCKED**

## レイヤー別ファイル

- Domain / Application: `review-003-domain-app.md`（B: 8 / W: 2 / N: 2）
- Cloudflare / Infrastructure: `review-003-cloudflare-infra.md`（B: 5 / W: 5 / N: 3）
- Identity / Security: `review-003-identity-security.md`（B: 8 / W: 3 / N: 3）
- Search / Data / Jobs: `review-003-search-data.md`（B: 8 / W: 6 / N: 3）
- Tests / Spec: `review-003-tests-spec.md`（B: 8 / W: 4 / N: 2）

## 修正方針

- identity domain/application から物理shard詳細を隠し、fresh retry・競合補償・全sagaを本番条件で収束させる
- rotation/reconcileを永続job/Alarmへ接続し、PITRをrestore適用証明・allowlist・conflict zeroでfail closedにする
- search schemaを履歴/OCC/AI connectionまで拡張し、semantic writeとretention jobをatomicかつboundedにする
- 本番DOからlocal raw harnessを除去し、全User Data identity RPCをversioned envelopeへ統一する
- clean install CI、production request boundary、semantic traceability、migration/restart、大規模・fault testを実証する

すべての Blocker / Warning を修正対象とする。
