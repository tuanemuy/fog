# 開発とテスト

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint:fix
pnpm format
pnpm test
pnpm build
```

`test:unit` は domain / presentation とローカル provider・launcher の契約試験。`test:integration` は fog の実 libSQL database を各試験で分離する。backup 試験も新しい一時 DB へ復元する。外部サービスへの接続と実メール送信は含まない。

`.goal-implement` は実装管理・独立検証の証跡で、通常 unit の探索対象外。製品テストは `apps/web` と `packages/core` に置く。採用していない runtime や Todo sample のテストは製品コードとともに削除済み。

UI を確認するときは `pnpm build && pnpm start` で production を起動する。PC と390px mobile でログイン、メモ投稿/編集、topic・文書・出典、履歴差分/復元、検索、trash復元、export、AI認可を操作する。変更のない領域の根拠を保持し、共通配線の変更には新しい production 操作を記録する。

[アカウント fixture](account_access.md) と [AI client fixture](ai_client.md) は繰り返し使用できる。Google/SMTP/Turso の実接続を fixture の結果で合格にしない。
