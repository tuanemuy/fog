# 動作確認計画 — Issue #19: Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

**Issue:** #19
**作成日:** 2026-07-28

## 実施結果

自動検証の実測値、基準commit、未実施のremote release gateは
[`test-results.json`](./test-results.json) を正本とする。working tree上の
検証であるため、commit/push後はCI runを同ファイルへ追記する。

PITRの実staging smokeとsecret inventoryだけはCloudflare資格情報と
disposable objectが必要なrelease gateとして未実施。ローカルでは
User Data canonical target、Directory全authority cursor reconcile、
schedule→restart→verify→undo protocolまでを自動検証した。

## 確認環境

この Issue の変更確認に必要な手順だけを記載する。実装中に既定 script を Cloudflare + DO の単一構成へ更新するため、完了時点で package scripts と再照合する。

### 検証環境の起動

```bash
# Cloudflare/workerd 開発環境
pnpm dev:cf
```

実装後は `dev:cf` と同じ2 Worker構成を既定の `pnpm dev` から起動できることも確認する。起動後 `http://localhost:3000` を開く。

### 自動・契約検証

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration:cf
pnpm test:lifecycle:cli
pnpm audit:legacy
pnpm audit:test-traceability
pnpm build:cf
pnpm deploy:staging:dry
```

### デプロイ方法

PITR はローカル workerd では利用できないため、専用 staging object の非破壊 smoke に限って次の既存 script を用いる。

```bash
pnpm deploy:staging
```

本番 deploy は行わない。

### Secret の準備

production request Worker へ設定する値は次のコマンドで生成する。実投入は本番 deploy を行う作業時に実施し、本検証では staging/local の値を使う。

```bash
openssl rand -base64 32
pnpm --filter @repo/web exec wrangler secret put SESSION_SECRET --config wrangler.request.production.toml
pnpm --filter @repo/web exec wrangler secret put DIRECTORY_ROUTING_SECRET_ACTIVE --config wrangler.request.production.toml
pnpm --filter @repo/web exec wrangler secret put PITR_OPERATOR_TOKEN --config wrangler.request.production.toml
pnpm --filter @repo/web secrets:check:production
```

state/DO Worker config に `SESSION_SECRET` と directory routing secret が存在しないことを dry-run 出力で確認する。

## 確認項目

### 1. 既存のアカウント登録・ログイン・設定表示・ログアウトが DO 構成で動く

- **対応する受け入れ基準:** AC-1 / AC-2 / AC-10 / AC-16
- **目的:** #1 で実装済みの identity 縦スライスが request Worker → Identity Directory / Account Home / User Data DO の経路へ移行していることを確認する。
- **手順:**
  1. `pnpm dev:cf` で環境を起動する。
  2. シークレットウィンドウで `/signup` を開き、未登録メールと有効なパスワードで登録する。
  3. `/settings` でメール、認証方式、設定値を確認する。
  4. ログアウトし、同じ資格情報で `/login` から再ログインする。
  5. 再読み込み後もセッションが維持されることを確認する。
- **期待結果:** 登録・再ログイン・current user 合成・ログアウトが成功し、利用者入力や URL に DO ID / routing key / userId を指定する面がない。
- **確認ポイント:** browser/network/log に生の password hash、SSO subject、HMAC routing key、DO ID が不要に露出しない。

### 2. 利用者データが User Data DO ごとに物理分離される

- **対応する受け入れ基準:** AC-1 / AC-4
- **目的:** 2ユーザーのデータが同じ共有 SQLite へ混在せず、別 object の private storage に保存されることを確認する。
- **手順:**
  1. 確認項目1の利用者に加え、別メールで2人目を登録する。
  2. `pnpm test:integration:cf` を実行し、physical isolation contract の結果を確認する。
  3. 片方の User Data DO に作った fixture がもう片方の検索・export結果へ出ないことを確認する。
- **期待結果:** 各 object の schema は同じでも行データは交差せず、別ユーザーの DO を選ぶ公開入力もない。

### 3. FTS5 のメモ・文書 lifecycle が同一 transaction で整合する

- **対応する受け入れ基準:** AC-5 / AC-6 / AC-16
- **目的:** 最小 lifecycle command harness を通じて、本体と FTS projection の作成・編集・削除・復元がatomicであることを確認する。
- **手順:**
  1. `pnpm test:integration:cf` を実行する。
  2. lifecycle contract の memo/document create、update、remove、restore の各結果を確認する。
  3. 本体 write 失敗と projection write 失敗の fault injection が双方 rollback になることを確認する。
  4. `pnpm test:lifecycle:cli` で local-only Worker を一時起動し、同じfixture操作と各操作直後の検索結果一覧を目視する。
- **期待結果:** commit 成功時だけ本体と索引が同時に変わり、片側だけの状態が残らない。manual CLI は local/test artifact にだけ存在する。

### 4. 日本語・短語・topic・ゴミ箱・非ベクトル契約が検索結果へ反映される

- **対応する受け入れ基準:** AC-5 / AC-6 / AC-7
- **目的:** FTS5 単独の検索仕様と既存の非ベクトル結果契約を確認する。
- **手順:**
  1. `pnpm test:integration:cf` を実行する。
  2. NFKC 正規化済み日本語3文字以上、1〜2文字、英数の結果を確認する。
  3. optional単一topicの未指定・既知・unknown、複数topicに関連するcontent、ゴミ箱除外を確認する。
  4. 順位とID tie-breaker、snippet、種別DTO、source links、出典memo、archive済みtopic、UI/AI共通query semantics のケースを確認する。
- **期待結果:** 期待する一致・順位・絞り込みになり、Vectorize/embedding/RRF の外部呼び出しや結果フィールドがない。
- **確認ポイント:** 50-byte pattern guard と pagination の「同一snapshot内」保証が明示的にテストされる。

### 5. Identity saga が部分失敗と世代競合から回復する

- **対応する受け入れ基準:** AC-2 / AC-3
- **目的:** email/SSO lookup、Account Home coordinator、credential shard reservation、User Data初期化が分散 transaction なしで一意に収束することを確認する。
- **手順:**
  1. `pnpm test:integration:cf` を実行する。
  2. reserve後init失敗、init後finalize失敗、同一operation再送、期限切れ回収を確認する。
  3. SSO provider/subject の初回、再送、同時初回、email競合、provider境界を確認する。
  4. active/previous key 世代を跨ぐ同時 signup、移送、全bucket rotation checkpointを確認する。
- **期待結果:** mapping は一意、reverse locator は完全で、orphan/二重 user が残らない。

### 6. 既存のアカウント列挙耐性が維持される

- **対応する受け入れ基準:** AC-2 / AC-16
- **目的:** Directory lookup の分割後も、公開応答から登録有無や認証方式を判別できないことを確認する。
- **手順:**
  1. `/login` で未登録メール、SSO-only fixture、誤パスワード、不正形式を順に送信する。
  2. 表示される status、error code、message を比較する。
  3. `pnpm test:integration:cf` の dummy verification contract を確認する。
- **期待結果:** 公開 error は同じで、未登録/SSO-only経路も同じ高コスト dummy verification を通る。PII がログへ出ない。

### 7. schema migration と永続 job / Alarm が再実行可能である

- **対応する受け入れ基準:** AC-11 / AC-12
- **目的:** object単位 lazy migration と at-least-once job が失敗・再起動後も回復することを確認する。
- **手順:**
  1. `pnpm test:integration:cf` を実行する。
  2. migration の初回、再実行、途中失敗rollbackを確認する。
  3. job lease expiry/reclaim、owner CAS、provider idempotency、poison、Alarm retry上限後の再設定を確認する。
  4. eviction と再起動後の最早 `nextRunAt` 再計算を確認する。
- **期待結果:** migration は各objectで一度だけ適用され、失敗時に半端なschemaを残さない。jobは失われず、重複しても外部副作用が冪等である。

### 8. 2 Worker の設定・build・dry-runがsecret境界を守る

- **対応する受け入れ基準:** AC-9 / AC-10 / AC-16
- **目的:** request Worker と state/DO Worker の class export、binding、RPC version、deploy順序、secret配布を確認する。
- **手順:**
  1. `pnpm build:cf` を実行する。
  2. `pnpm deploy:staging:dry` を実行し、binding/bundle整合を確認する。
  3. 認証済みリリース環境で `pnpm --filter @repo/web secrets:check:staging` を実行し、secret名のinventory gateを通す。
  4. request/state の生成設定と binding を確認する。
  5. `pnpm dev` で multi-config local dev を起動し、確認項目1を再実行する。
- **期待結果:** User Data / Identity Credential Shard / Account Home の3 SQLite classがstate Workerにexportされ、request Workerからだけbindingされる。state Workerにsession/routing secretがなく、必要な外部adapter secretだけが最小配布される。

### 9. PITR・退会削除・export の運用境界が安全である

- **対応する受け入れ基準:** AC-13
- **目的:** 後続usecaseを先取りせず、schema primitiveとoperator手順が安全に機能することを確認する。
- **手順:**
  1. staging の disposable User Data DO でbookmark取得と非破壊restore smokeを行う。
  2. Account Home restoreをadmin toolingが拒否することを確認する。
  3. non-PII tombstone/epochを照合してからDirectory/User Data復旧を続行する手順を確認する。
  4. local integrationでdeleting tombstone→User Data delete確認→mapping purgeと逐次export primitiveを確認する。
- **期待結果:** Account Homeの権威状態を過去へ戻さず、削除済み利用者を誤って復活させない。後続 #11/#12/#15 のUI/usecaseは実装されない。

### 10. 旧runtime・D1・Vector設計がactive pathに残らない

- **対応する受け入れ基準:** AC-7 / AC-8 / AC-9 / AC-14 / AC-15
- **目的:** 削除・spec同期・ADR supersede・Issue #10更新が完了していることを確認する。
- **手順:**
  1. legacy allowlist audit を含む `pnpm test` を実行する。
  2. `.issue/1/adr.md` と `spec/adr/005-search-index-via-outbox.md` の superseded pointer を確認する。
  3. Issue #10 本文が #19 依存のFTS5単独チェックリストになっていることを確認する。
  4. Cloudflare Pulumi が D1/Queue outputsを持たず、DNS/routesに限定されていることを確認する。
- **期待結果:** 履歴・superseded文書以外のactive source/config/specに Node/libSQL/D1/AWS/GCP/Vectorize/embedding/RRF/hybrid/transport Outbox が残らない。

## エッジケース・異常系

### 1. RPC version mismatch と片側 deploy失敗

- **目的:** 2 Worker の互換windowとrollback手順を確認する。
- **手順:**
  1. synthetic auxiliary worker で旧/新 RPC version envelope を組み合わせる。
  2. state先行→request後続のdeploy順、request rollbackを確認する。
- **期待結果:** 互換versionは処理され、非互換versionは構造化errorになり、データ変更を行わない。

### 2. platform overload と容量・入力上限

- **目的:** Cloudflare固有errorとguardを確認する。
- **手順:**
  1. synthetic `.retryable` / `.overloaded` errorをRPC adapterへ返す。
  2. SQL parameter、LIKE pattern、Alarm batch/time budget、`SQLITE_FULL` の境界caseを実行する。
- **期待結果:** 冪等operationのretryableだけが上限付きretryされ、overloadedは無条件retryされない。上限違反はadapter errorへ変換される。

## 既存機能への影響確認

- signup/login/current user/logout、session cookie、認証必須route、設定画面が既存と同じ公開契約を保つ。
- password change/reset、SSO UI、user export UI は後続 #11/#12/#15 のままで、#19 が中途半端な公開UIを追加しない。
- `spec/` の memo/knowledge/trash/search/identity がDO単独、同期projection、Alarmの同じ前提を使う。
- `README.md` / `CLAUDE.md` / package scripts / Wrangler / Cloudflare Pulumi が同じ2 Worker構成を示す。
