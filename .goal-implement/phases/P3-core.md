# P3 core 完了候補

対象: R10〜R15 の domain/application/libSQL adapter。Web UI・worker起動配線・ブラウザは親 Implementer が担当。独立検証前の完了候補。

## 実装

- 三種のソフト削除、削除グループ、残日数。トピック復元は同じ削除操作の文書だけを復元する。個別文書からの親トピック復元には明示確認を要求する。
- 完全削除は対象履歴・出典を消去。トピックの先行個別削除文書を孤立状態で保持し、既存または新規トピックへ原子的に復元する。nullable parent と active orphan 禁止 CHECK を導入。既存DBの移行は文書・履歴・リンクを同一transactionで再構築する。
- 人間向け出典の墓標を維持し、AI向けメモ・文書・トピック・タイムラインから削除済み出典の本文・タイトル・識別子を除外する。ゴミ箱・復元・完全削除・設定・export・履歴の人間限定をruntimeでも検査する。
- 保持期限は既定30日、1〜3650日。時計注入の purgeExpiredTrash は全所有者の現在設定を使い、期限境界を含む期限切れゴミ箱だけを処理する。完了済みの稼働中トピックは削除しない。
- 日本語を含む最新メモ本文・最新文書タイトル/本文の共通検索。空キーワードは無検索。完了済み含む、ゴミ箱除外。topic scope は配下文書と出典メモ。作成時刻/id/種別のkeyset、query/scope拘束cursor、原文snippet、稼働中出典IDを返す。
- export は schema version付きJSON。最新メモ・文書・トピックと完了状態・稼働中出典IDを含め、ゴミ箱・履歴・所有者情報・別ユーザーデータを含めない。

## 検証

- `pnpm --filter @repo/core typecheck`: 成功。
- `pnpm exec biome check --write packages/core/src/application/fog packages/core/src/adapters/fog packages/core/src/domain/fog`: 成功。最終 `biome check` も成功。
- `pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__`: 3 files / 32 tests 成功（P3追加16件、既存16件）。最終domain検証関数の抽出後にも再実行した。
- 実SQLiteで所有者隔離、正確なセット復元、先行削除保持、孤立文書の既存/新規復元、破壊的削除の履歴・リンクcascade、削除/復元/完全削除途中失敗のrollback、期限境界/短縮/全所有者、検索の日本語・即時反映・出典scope・同一時刻pagination・同時挿入/編集、export、AI runtime拒否と墓標漏洩防止、旧schema移行のデータ保持と反復実行を確認。
- root typecheck/lint/format/test/build とブラウザ統合確認は親 Implementer が実行する。core単体の結果を全体検証と扱わない。

## 実行と引き継ぎ

Nodeサーバー再起動時の既存 migrateFog が旧DB移行を実行する。自動削除の公開入口は `application/fog/trashServices.ts` の `purgeExpiredTrash({unitOfWork,clock})`。FogServicesの人間操作/API契約は `dataTypes.ts` に定義。

Coreの未完了項目・既知の機能不具合なし。browser・worker無操作実行はこの報告の対象外。全体goal・Manager台帳は変更していない。コード書き込みを停止し、独立検証または親からの具体的な修正依頼を待つ。

## 対象記録

日時: 2026-09-05T10:56:39.715462+00:00

HEAD: `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。未コミットの既存P1/P2成果を含む対象を記録。

| ファイル | SHA-256 |
| --- | --- |
| `packages/core/src/adapters/fog/__tests__/content.integration.test.ts` | `8bcc832ce9ef8237dc4245d97ea3e3d71c21e204af3f5adcd34e67603c8bb3b0` |
| `packages/core/src/adapters/fog/__tests__/data.integration.test.ts` | `84be18bd96beda3b8afa33a2ae2e79c1750cde9f245a9b1a0ebd66650f8ff179` |
| `packages/core/src/adapters/fog/__tests__/services.integration.test.ts` | `7d0596b459f471e134c91267dede92d29fb9e9209c5d43dc7fd8950b7ac4a66c` |
| `packages/core/src/adapters/fog/contentRepositories.ts` | `e5373f477573dfef39a0f1afb6913c61ae5a3cd1c63b532cbf2336029db330f4` |
| `packages/core/src/adapters/fog/crypto.ts` | `f4c59d108cdaa8021135581b524d8978e83950832ed074963233d710550b39ff` |
| `packages/core/src/adapters/fog/dataRepository.ts` | `554dbcb9ed3a1d3f99df9786fb9d0f97234702d783b82bc346430d43d7258f76` |
| `packages/core/src/adapters/fog/schema.ts` | `0878481c5f082087563ddf0298905b701b7e6e30b5eb0c6b9b6025fc402b9e69` |
| `packages/core/src/adapters/fog/unitOfWork.ts` | `dae7bda4e23f0a1a68c0dc37809398bb5a6028ff79ab06601d3c82f9f2d735fe` |
| `packages/core/src/application/fog/contentSupport.ts` | `395e8c276eb90d92f568dc65dd29530f8c185b33c9e9ef5fcdca344e646e2778` |
| `packages/core/src/application/fog/dataTypes.ts` | `bd44cbae41797b5fd20fcdbceaea763d2443e8593057ae2f046b77771247d21b` |
| `packages/core/src/application/fog/documentServices.ts` | `a2bc85cd42e7b191002d5f6e946a884419dd0fa893551f7a31e62dc28e4d75b7` |
| `packages/core/src/application/fog/memoServices.ts` | `a05352388ad763831839fe16b8d0222cbeba13545e9a3722471477e785b8235e` |
| `packages/core/src/application/fog/ports.ts` | `23ac2c2754ec4bdc61ab5058d8af95b35174f122dcf617a6edda94123e51f8e5` |
| `packages/core/src/application/fog/runtime.ts` | `bbedf8c7f96349030f6c0a73eba4c4274e99caad26578adfc7e561813275de04` |
| `packages/core/src/application/fog/searchServices.ts` | `c6d861077d40d0497a671ef2d0b9c7c1ac4512484b10414c87536893930f937a` |
| `packages/core/src/application/fog/services.ts` | `970fa45752a6053fb54eef38c817cf61347757117bf417cdee747c0e092d5f01` |
| `packages/core/src/application/fog/topicServices.ts` | `d8eff69707b0233f8ac4f3c821867263c9a0b57e00efb546114a95322078d2df` |
| `packages/core/src/application/fog/trashServices.ts` | `7a2341bb1b986abaebd3fdfb53ed52982d165ffc2ee32a7c3ddf754758f392f3` |
| `packages/core/src/application/fog/types.ts` | `1de7b6269bfa2cae79b0b5c450618e5fea335919bef51c1b9cc6ee299803c088` |
| `packages/core/src/domain/fog/content.ts` | `f8d402bb3aab8e0a77d08c956c452a51998796a7b2a5f205186bff5f78526c39` |
| `packages/core/src/domain/fog/data.ts` | `5d46967e30fb15b3e202c6232939066a15ef6a71c619fec589f3f685b21d329c` |
