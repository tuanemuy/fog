# バックエンド実装

`packages/core/src/application/fog` の usecase が domain 値と ports を使い、`LibsqlFogUnitOfWork` が一つの transaction に repository 操作を閉じ込める。adapter が driver error を application error に翻訳し、HTTP status と serialization は presentation に置く。

メモ更新は `memoServices.ts` を参照する。現在版・変更内容・所有者を確認し、更新と revision の追加を同じ UoW で確定する。AI 書込みは `aiOperations.ts` の同じ操作を呼び、冪等性 key・payload・receipt を同じ transaction に記録する。

人間用 trash/history/export DTO と AI 用 projection は分離する。成功 replay でも現在の公開可能な entity だけを再取得し、削除済み metadata を返さない。復旧や完全削除は人間用操作に限定する。

`accountPorts.ts` は Google・SMTP の外部契約。外部 token 交換や SMTP 通信の間は DB transaction を保持しない。状態を再検査してから commit する。配送 outbox は token と同じ UoW で enqueue し、`resetEmailDispatcher.ts` が claim・retry・完了を処理する。

時計・ID・暗号を引数の port として受け取る。domain/application は ambient time や I/O を直接使わない。実 DB 試験は `packages/core/src/adapters/fog/__tests__` にあり、並行・rollback・owner分離・migrationを確認する。
