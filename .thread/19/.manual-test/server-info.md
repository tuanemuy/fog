# サーバー情報

- 起動コマンド: `pnpm dev:cf`
- ポート: 8787
- URL: `http://localhost:8787`
- プロセス: workerd PID 25304（Codex exec session 54341）
- 依存インストール: 既存 workspace を使用
- ビルド: Wrangler の custom build が起動時に実行
- 検出ソース: `README.md` と `apps/web/wrangler.request.toml`
- ヘルスチェック: `/` が HTTP 307 を返し、認証ルートへ正常にリダイレクト
- 再起動: TC-001 の修正ごとに artifact を再生成し、最終再検証は最新 artifact で実施

`testing.md` の `localhost:3000` は Vite 単体設定のポートであり、2 Worker
構成の実際の request Worker URL は `localhost:8787` だったため、後者を使用した。
