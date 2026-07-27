# PR #33 第6回レビュー — Search / Data / Jobs / Application

## 判定

**RESOLVED**

対象: `main...29b9ebd29511d3ca58d36fcacf03f7b1286e9e80`

Issue #19、`.thread/19/plan.md`、現行 `spec/`、第5回レビューの全指摘と現行実装・テストをゼロベースで照合した。第5回の Blocker 5件と Warning 4件について、同期 callback の型・実行時拒否、application repository/projection orchestration、topic touch と destination restore の通常経路での version +2、実 projection fault、Alarm の自動 retry/restart、migration、bounded maintenance、破損 payload、projection ownership の各修正は有効である。

初回確認では document restore の destination 指定に1つ未検証の状態組合せが残り、対象ファイルの静的チェックも1件失敗した。いずれも同ラウンドで修正し、専用 Search テスト、全 Search unit、型検査、対象 Biome チェックの通過を確認した。

## Blockers

なし。

## Warnings

### W-SDJ6-001 — restoreAlone に同一 destinationTopicId を指定すると、移動していない document の version が2進む（RESOLVED）

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:638-664`
  - `packages/core/src/application/search/contracts.ts:192-198`
  - `packages/core/src/application/search/prepareSemanticCommand.ts:286-304`
  - `spec/usecases/trash.md:153-167`
  - `spec/domains/knowledge.md:227`
- 根拠:
  - 初回確認時は、元 topic が存命する document に `destinationTopicId` を渡した場合、guard が元 topic と異なる ID だけを拒否し、同じ ID は受理していた。
  - 初回確認時の `versionIncrement` は実際に topic が変わったかではなく `destinationTopicId !== undefined` だけで2を選んでいた。そのため `moveToTopic` が発生しない restoreAlone 相当でも version が2進んでいた。
  - spec で version +2 になるのは、元 topic がハードデリート済みの `selectDestination` で `moveToTopic`（+1）から `restore`（+1）へ遷移する場合だけである。元 topic が存命する `restoreAlone` は restore の+1だけである。
  - 現行テストは destination 省略の restoreAlone と、元 topic 削除後の destination 指定を検証するが、この同一 ID 指定を検証しない。
- 影響:
  - RPC/application contract が意味的に無効な destination 指定を受理し、domain の状態遷移数と OCC token が不一致になる。将来の caller が不要な同一 destination を付けるだけで後続 expectedVersion がずれる。
- 提案:
  - `current.topic_id !== null` の場合は、同一 ID か否かにかかわらず destination 指定を拒否する。
  - version +2 は元 topic が消失し、実際に destination へ付け替えた分岐だけに限定する。
  - 同一 destination 指定が拒否されること、通常の restoreAlone が version +1 のままであることを integration test で固定する。
- 解消確認:
  - 元 topic 存命時は destination 指定を ID の一致にかかわらず拒否するよう修正した。
  - version +2 の条件を `movedToDestination` へ限定し、destination の存在だけでは version が2進まないようにした。
  - 同一 destination 指定後に document/topic が不変であることと、続く正規 restoreAlone が document/topic とも version +1 になる integration test を追加した。

### W-SDJ6-002 — Round 5 修正対象ファイルが Biome の import 整列チェックに失敗する（RESOLVED）

- 場所:
  - `apps/web/app/testing/LocalUserDataDurableObject.ts:1-10`
- 根拠:
  - 対象差分へ `pnpm exec biome check ...` を実行すると、`assist/source/organizeImports` が1件失敗する。
  - `SearchProjectionFaultPoint` の type import が adapter import 群より後ろにあり、Biome が提示する canonical order と一致しない。
- 影響:
  - 対象差分の静的品質ゲートが green にならない。
- 提案:
  - Biome の safe fix 相当で import を整列し、対象差分への `biome check` を再実行する。
- 解消確認:
  - `LocalUserDataDurableObject.ts` の import を Biome の canonical order へ整列した。
  - Search/Data/Application 対象14ファイルの `biome check` 通過を確認した。

## Notes

### N-SDJ6-001 — 第5回指摘の解消確認

- B-SDJ5-001: callback は `undefined` 戻り値になり、runtime thenable guard と型テストが追加された。
- B-SDJ5-002: application が command 別 repository capability を選択し、返却された projection mutation を scoped projection に適用する。
- B-SDJ5-003: create/restore の topic CAS touch と、親 topic 消失後の destination move + restore の version +2 が通常経路へ実装された。
- B-SDJ5-004: fault は実 FTS/search entry write 内へ注入され、transaction rollback を検証する。
- B-SDJ5-005: fake clock、保存 Alarm 時刻、attempt 間 eviction により、DB の due 時刻を書き換えず最大 retry 後の poison 化を検証する。
- W-SDJ5-001〜004: settings version migration、reclaim/prune 25件制限、canonical subject による retention 再計算、source projection ownership の spec/型整合を確認した。

### N-SDJ6-002 — 検証結果

- `pnpm --filter @repo/core typecheck`: pass
- `pnpm --filter @repo/web typecheck`: pass
- `pnpm test:unit`: 35 files / 426 tests pass
- Search unit: 2 files / 96 tests pass
- Search integration: 1 file / 19 tests pass
- 対象14ファイルの `pnpm exec biome check ...`: pass
- 全 state integration は並行修正中の Identity ファイルに限って失敗した。Search integration は全件通過しており、本修正との依存・失敗はない。
- `git diff --check main...HEAD`: 対象外の既存 Markdown 4件で fail。今回のレビューでは変更していない。
- 本修正は commit、pushしていない。
