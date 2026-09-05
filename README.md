# fog

気軽に残したメモを、AIと育てるアプリ。メモのタイムライン、トピックと文書、出典リンク、履歴と復元、検索、ゴミ箱、認可した AI クライアントによる編集を提供する。

Node.js 22.12以上、pnpm 11.1.2、libSQL を使う。Web は TanStack Start / React 19、core は framework 非依存の domain・application・adapter で構成する。

## 起動

```sh
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env
pnpm db:migrate
pnpm dev
```

既存 `.env` がある場合はコピーせず必要なキーだけを確認する。`http://localhost:3000` を開く。ローカル DB の相対パスは `apps/web` 基準。

```sh
pnpm typecheck
pnpm lint:fix
pnpm format
pnpm test
pnpm build
pnpm start
```

`pnpm start` は build 済みの production server と静的ファイルを配信する。Node の同じプロセスでゴミ箱の保持期限処理と復旧メール配送を動かす。SIGINT / SIGTERM で HTTP と実行中 worker を drain して終了する。

## 設定と運用

- [Node 運用](docs/runtime_node.md): 起動、環境変数、migration、production、health、停止、クラウド DB。
- [バックアップと復元](docs/backup_restore.md): 一貫した snapshot、保持、新 DB への復元と訓練、クラウド PITR。
- [アカウント認証と復旧](docs/account_access.md): Google と SMTP の設定、ローカル OIDC / メール受信箱。
- [AI クライアント](docs/ai_client.md): 操作一覧、認可、PKCE、ローカルクライアント fixture。
- [データ運用](docs/fog_operations.md): ゴミ箱の保持期限と利用者向け export。
- [開発とテスト](docs/test.md): 必須チェックと対象。

Google・SMTP・クラウド libSQL の実接続には利用する環境の設定が必要。ローカル fixture は外部サービスの確認を代替しない。自動 deploy は構成していない。

## 構成

| 場所 | 内容 |
| --- | --- |
| `apps/web` | 画面、HTTP、Node entry、worker、運用 CLI |
| `packages/core` | fog domain、usecase、ports、libSQL / Google / SMTP adapter |
| `infra/node` | 単一 Node process の systemd 設定例 |
| `spec` | 原要件、シナリオ、画面設計 |

[バックエンド実装](docs/backend_implementation_example.md)と[フロントエンド実装](docs/frontend_implementation_example.md)は現在の fog のコードを参照する。
