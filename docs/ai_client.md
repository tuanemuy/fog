# AIクライアント接続

fog の AI API は利用者の代理でメモ・ドキュメント・トピックを読み書きする。ゴミ箱の閲覧・復元・完全削除、履歴、アカウント設定は人間用UIで操作する。

## 登録とローカル接続

Node の `FOG_AI_CLIENTS` に、クライアントID・表示名・戻り先URIを登録する。未設定なら接続可能なクライアントはない。戻り先は登録値との完全一致が必要で、HTTPSまたはloopback HTTPに限る。ユーザー名・パスワード・fragment・`code` / `state` / `error` queryを含めない。

```bash
DATABASE_URL=file:./data/app.db \
APP_URL=http://localhost:3000 \
FOG_AI_CLIENTS='[{"id":"fog-local-client","name":"ローカルAIクライアント","redirectUris":["http://127.0.0.1:3456/callback"]}]' \
pnpm dev
```

別のターミナルで、ローカルクライアントを起動する。

```bash
pnpm --filter @repo/web exec tsx scripts/fog-ai-client.ts authorize
```

表示されたURLをブラウザで開く。未ログインならログインし、操作一覧を確認して許可または拒否する。クライアントは127.0.0.1:3456で戻りを受け、stateを照合し、PKCEでコードを交換する。許可時の認証情報は `/tmp/fog-ai-local-token.json` に所有者のみ読み書き可能な権限で保存する。拒否時は保存しない。

`FOG_URL`、`FOG_CLIENT_ID`、`FOG_REDIRECT_URI`、`FOG_TOKEN_FILE` で接続先と保存先を変更できる。ローカルfixtureのcallbackは明示port付き127.0.0.1に限る。認証情報をコマンド引数やURLへ含めない。

## 認可プロトコル

1. `GET /oauth/authorize` に `response_type=code`、`client_id`、登録済み `redirect_uri`、ランダムな `state`（16〜512文字）、`code_challenge`、`code_challenge_method=S256` を指定する。
2. fog は検証済み要求を10分間保存し、人間用 `/ai/authorize` へ案内する。認可画面を最初に表示した利用者へ要求を拘束する。許可時は2分間有効な単回codeと元のstate、拒否時は `error=access_denied` と元のstateを登録戻り先へ返す。不正な戻り先にはredirectしない。
3. クライアントはstateを照合し、`POST /oauth/token` にform-urlencodedで `grant_type=authorization_code`、`client_id`、`redirect_uri`、`code`、`code_verifier` を送る。verifierは43〜128文字のPKCE文字集合、challengeはSHA-256のbase64url・paddingなしとする。
4. 応答本文の `access_token` を保存する。`token_type` はBearer、`expires_in` は2592000秒（30日）。refresh tokenは提供しない。期限切れ・接続解除後は認可をやり直す。

認可要求・code・tokenの秘密値はDBへhashで保存する。交換応答とAPI応答はno-store。接続の有効性をすべての操作と再試行で検査する。公開clientには共有secretを要求しない。[PKCEの定義](https://www.rfc-editor.org/rfc/rfc7636)

## 操作

`POST /api/ai` に `Authorization: Bearer <access_token>` と `Content-Type: application/json` を付け、`{"operation":"...","input":{...}}` を送る。人間用cookieを併用しない。主体・所有者はtokenから決まり、要求で指定できない。

| operation | input |
| --- | --- |
| `guidance` | `{}`。利用可能操作と推奨する振る舞いを返す |
| `memos.recent` | 任意の `limit`、`cursor` |
| `memos.get` | `id` |
| `topics.list` | `{}` |
| `topics.get` | `id`。配下文書と関連メモを含む |
| `documents.get` | `id`。最新本文と稼働中の出典を含む |
| `search` | `query`、任意の `topicId`、`limit`、`cursor` |
| `memos.create` | `body` |
| `memos.replace` | `id`、`body`、`expectedVersion` |
| `topics.create` | `title`、`description` |
| `topics.update` | `id`、`title`、`description`、`completed`、`expectedVersion` |
| `documents.create` | `topicId`、`title`、`body`、`sourceMemoIds`、`reason` |
| `documents.patch` | `id`、`expectedVersion`、`find`、`replace`、`reason`、任意の `title` |
| `documents.rewrite` | `id`、`expectedVersion`、`title`、`body`、`reason`、`confirmRewrite:true` |
| `content.delete` | `kind`（memo/document/topic）、`id`、`expectedVersion` |

検索は人間UIと共通で、日本語・完了済みを含む。空queryは検索しない。topic scopeは配下文書と出典メモ。結果は原文snippetと事実情報のみで、要約はクライアントが行う。次ページには返されたcursorと同じquery/scopeを使う。

文書の部分編集は一意な完全一致と版の一致を要求する。0件・複数件・重なる一致、本文全体を置換するpatchは拒否する。全面書き直しは利用者の明示依頼がある場合だけ `documents.rewrite` を使う。クライアントがこの確認を正しく行うためのガイダンスと、明示操作・版・理由のサーバー検証を組み合わせる。

## 書き込みと再試行

書き込み8操作はトップレベルの `idempotencyKey` が必須。1〜200文字の印字可能ASCIIを使い、同じ要求を再試行するときは同じkeyとpayloadを送る。payloadを変更した要求には別keyを使う。

```bash
pnpm --filter @repo/web exec tsx scripts/fog-ai-client.ts api \
  '{"operation":"guidance","input":{}}'

pnpm --filter @repo/web exec tsx scripts/fog-ai-client.ts api \
  '{"operation":"memos.create","input":{"body":"次の設計で試すこと"},"idempotencyKey":"conversation-001-memo-001"}'
```

読み取り応答は `{kind:"read", operation, data}`。書き込み応答は `{kind:"receipt", operation, requestId, replayed, resource}`。resourceは現在有効な項目のkind/id/versionで、削除済みまたは削除操作ならnull。本文が必要な場合は単体取得する。

冪等性は接続ごとのkeyとpayloadへ拘束する。並行要求・プロセス再起動後も、成功済みの要求を再更新しない。同keyの異payloadは409。receiptのresourceは再試行時点の最新状態で、過去の応答本文を再生しない。後で削除された項目はIDも返さずnullになる。削除後に人間が復元しても、成功済み削除要求の再試行で再削除しない。失効した接続にはreceiptも返さない。

## エラーと接続解除

| HTTP | 対応 |
| --- | --- |
| 401 | 認証情報・期限・接続を確認し、必要なら利用者に再接続を依頼する |
| 403 | 人間用操作・cookie併用などの境界を確認する |
| 404 | 対象は取得できない。削除済み項目も同じ扱い |
| 409 | 最新版を取得し直す。同keyのpayload変更なら新しい要求に別keyを使う |
| 422 | 要求形状、必須の変更理由、一致対象、値の不変条件を確認する |

設定画面の「接続済みAIクライアント」に接続名・接続時刻・最終利用時刻が表示される。「接続を解除」の確認後、以後の読書きと再試行を拒否する。AIの編集は人間用履歴にクライアント名と理由が残り、人間がロールバックできる。
