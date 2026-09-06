# C4 final independent re-verification

- 実行日時: 2026-09-06T06:38:11+09:00〜2026-09-06T06:45:37+09:00
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- 対象 manifest: 65 files / `ebc4faa87e320b0c1c8a77bc5910503c98259f978dbb80c5f9704535b7f5592a`
- 判定: FAIL

## Manifest

`phases/C4.md` の Rework product manifest 65行を末尾改行付きで SHA-256 化し、指定 digest と一致することを確認した。`shasum -a 256 -c` は 65/65 paths PASS。検証開始時と終了時の HEAD も一致した。

## Blocker

### B-C4-FINAL-001: malformed Worker settings response を authority gate が成功扱いする

`apps/web/scripts/cloudflareAuthority.node.ts` は既存 Worker の確認に `GET /accounts/{account}/workers/scripts/{script}/settings` を使う。HTTP 2xx の JSON は `successSchema` へ渡すが、この schema は `{ success: true }` だけを要求する。公式 API response に必要な `result` の存在と形を検査しない。

一時 focused test で token と zone に正しい応答を返し、Worker settings に `{ "success": true }` だけを返した。期待した `Worker verification` rejection に対して `verifyCloudflareAuthority()` は `undefined` で resolve し、1 test / 1 failure を再現した。一時 test は実行後に削除した。

[Cloudflare Get Settings API](https://developers.cloudflare.com/api/go/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)は成功 envelope の `result` を Worker の設定 object と定義する。`result` がない応答は hostile/malformed response である。Rework の必須条件「malformed response fail-closed」を満たさないため、全体を FAIL とする。

修正要求: Worker settings 用 schema で公式 response の `result` object と authority 判定に必要な最小フィールドを検証する。欠落、`null`、配列、primitive、型違いを拒否する hostile test を追加する。response body、token、account ID はエラーへ含めない。

## Rework 判定

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| B-C4-QUALITY-001 PITR identity rebind | PASS | `DATABASE_IDENTITY_REBIND_FROM` は同一 stage の normalized authority だけを受理する。marker stage/from の完全一致を条件付き UPDATE で再検査し、marker更新と schema migration を同じ write transaction で commit/rollback する。migration failure の rollback、成功後の同一入力 retry、unexpected marker 拒否を実 SQLite test で確認した。bootstrap との同時指定、同一 old/new identity、別 stage、URL形式を preflight で拒否する。workflow は rebind 値を migration step だけへ渡し、runbook の登録・切替・削除順と一致する。 |
| B-C4-001 Release Please 初回設定 | PASS | 現 remote setting `can_approve_pull_request_reviews=false` から、既定 token の repository setting を有効化して確認する手順がある。代替の fine-grained PAT は対象 repository 限定、Contents/Pull requests/Issues Read and write、期限、rotation を記載する。GitHub App は repository限定 installation、同 permissions、run単位の短命 token 実装後だけ利用する。workflow job permissions も Release Please の公式契約と一致する。[Release Please Action](https://github.com/googleapis/release-please-action) |
| B-C4-002 `FOG_AI_CLIENTS` 削除収束 | PASS | optional secret の未登録・空白は payload の `FOG_AI_CLIENTS: null` になる。Wrangler 4.129.0 の JSON bulk stdin は `null` を削除として扱う。[Wrangler secret bulk](https://developers.cloudflare.com/workers/wrangler/commands/workers/) 必須4 secret は空でない string だけを受理する。runtime値は bulk stdin だけに入り、argvとchild envに入らない。child stdout/stderr、EPIPE、abort、exit error は discardされ、値を例外とログへ含めない。 |
| W-C4-001 Cloudflare authority | FAIL | migration前の順序、active token、exact account/active zone、既存 Worker/初回404、GET、official origin、redirect、timeout/abort、HTTP failure、cross-origin、secret非出力は PASS。Worker settings の malformed success envelope だけが fail-open。read-only check で edit scopeを証明できない残余と、migration後の同SHA retryは文書化済み。 |
| Email sender/domain/token permissions | PASS | sender domain onboarding、DNS record、verified gate、2 sender、Workers Scripts Edit、Workers Routes Edit、Zone Read、resource/expiry制限を具体化した。recipient/quota/bounceと実 edit scopeは外部 gateに残る。 |
| Cron | PASS | `0 3 * * *` を 03:00 UTC と明記し、変更反映に最大15分を見込む。重複・遅延・監視契約も実装と一致する。 |
| recovery dispatch | PASS | runbook は `gh workflow run ... --ref main` を指定する。release/tag/SHA/staging success と approval 後 revalidation の契約も workflow と一致する。 |
| health / smoke | PASS | GET/HEAD、DB readiness、200/503、`Cache-Control: no-store`、exact HTTPS origin/SHA/env/DB identity、18 attempts、10秒 timeout、5秒 retry、失敗 body 非出力を実装どおり記載する。 |
| doc-style / markdown-style | PASS | README と runbook は現在の状態と操作を断定で記載する。h1は各1件、見出しレベル飛び、水平線、見出し代用の強調、言語なし code fence、段落内の不自然な改行はない。 |

## 独立検証

| command / 検査 | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts apps/web/scripts/cloudflareDelivery.test.ts` | PASS、2 files / 111 tests。rebind、AI secret、authority、workflow hostile casesを含む。 |
| malformed Worker response 独立 test | FAIL、1 file / 1 test。`{success:true}` が rejection せず resolveした。一時 fileは削除済み。 |
| `pnpm typecheck && pnpm lint && pnpm format:check` | PASS。root/core/web type error 0、lint error 0、format 230 files。既存 `staticAssets.test.ts` の unsafe suggestion info 1件のみ。 |
| `pnpm test:unit` | PASS、16 files / 191 tests。 |
| `pnpm test:integration:node` | PASS、6 files / 94 tests。共有環境の待機で33.16秒、test failureなし。 |
| `pnpm test:integration:cloudflare` | PASS、2 files / 8 tests。終了時の既知 workerd disconnect診断のみ、exit 0。 |
| `pnpm build:node` | PASS。既存 CSS filename conflict warningのみ。 |
| staging/production render、pair validation | PASS。互いに異なる example DB identity と40桁 SHAを使用。 |
| staging fresh build / Wrangler dry-run | PASS、136 modules、3357.20 KiB / gzip 705.98 KiB。 |
| production fresh build / Wrangler dry-run | PASS、136 modules、3357.20 KiB / gzip 705.98 KiB。 |
| actionlint v1.7.12 | PASS、2 workflows diagnostics 0。Darwin arm64 archive SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f` を照合した。 |
| artifact secret scan | PASS。raw example DB URL、secret assignment/value、`.env`/`.dev.vars`、symlink 0。literal `libsql://` は URL boundary validator のみ。 |
| artifact Node-only scan | PASS。Node listener/fs/net/tls、SMTP、signal、migration、backup/restore、intervalは0。 |
| `/Library/Developer/CommandLineTools/usr/bin/git diff --check` | PASS、whitespace error 0。 |

Cloudflare build は runtime secret を渡さないため、Wrangler の required secrets warning を表示した。dry-run は side effect なしで成功した。生成した `apps/web/dist`、`apps/web/dist-cloudflare`、`apps/web/.cloudflare` と actionlint 一時 directory は最終照合前に削除した。

## 外部 gate

- Cloudflare account/zone/Workers Paid/custom domain/TLS、API tokenの実resource visibilityとsecret sync/upload/route edit scope
- Email Service sender domain/recipient/quota/bounce/重複配送
- Turso remote write transactionの5秒条件、競合、PITR、token権限
- Google OAuth client/consent screen/exact callback
- GitHub Environments、reviewer、branch policy、default-token settingまたはcustom token、GitHub-hosted workflow
- 実 Workers CPU/memory、Cron、Email配送、公開 health smoke

外部 credential、deploy、secret、repository setting、Environmentは変更していない。ローカル PASS は外部 gateを代替しない。

## Acceptance recheck

- 実行日時: 2026-09-06T07:02:46+09:00〜2026-09-06T07:09:22+09:00
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- 対象 manifest: 65 files / `b5dc067144dd3cedc29d2f182fa5a2935880804c7ff9d9c5ce032f4d452fef3c`
- 最終判定: PASS

Final rework manifest は digest と 65/65 paths が一致した。Rework manifest との差分は `apps/web/scripts/cloudflareAuthority.node.ts` と `apps/web/scripts/cloudflareStage.test.ts` の2件だけである。

`successSchema` は Worker settings の `success: true` と必須 `result` object を検証する。独立 fixture は `result` missing、`null`、array、string、`success: false`、malformed JSON、hostile body の7件をすべて拒否した。error文字列は hostile body と token を含まない。valid `result` object と初回404の2件だけが成功した。全9 cases は token verify、exact account/active zone、Worker settings の順で3 requestを実行した。

| 検査 | 結果 |
| --- | --- |
| 独立 authority matrix | PASS、9/9。一時 test は削除済み。初回は終了通知だけが滞留したため結果に採用せず、自分の process を停止した。最小環境の再実行は test 本体365 msで完走した。 |
| `cloudflareStage.test.ts` / `cloudflareDelivery.test.ts` | PASS、50 + 62 = 112 tests。token/zone/Worker、timeout/abort/redirect/cross-origin、migration前 ordering を含む。 |
| `pnpm typecheck && pnpm lint && pnpm format:check` | PASS。type error 0、lint error 0、format 230 files。既存 lint info 1件のみ。 |
| `pnpm test:unit` | PASS、16 files / 192 tests。 |
| `git diff --check` | PASS。 |
| artifact / temporary cleanliness | PASS。`apps/web/dist`、`apps/web/dist-cloudflare`、`apps/web/.cloudflare`、一時 test は存在しない。 |

前回 PASS の Node integration 94 tests、Cloudflare integration 8 tests、Node build、両 stage render/build/dry-run、actionlint、artifact secret/Node-only scanは継承する。Final rework で変わった2ファイルは Node/Worker runtime artifact と workflowを変更しない。authority operation scriptの型・全分岐・hostile inputは今回のfocused/unitで再検証した。

B-C4-FINAL-001 は解消した。外部 gate は前節から変わらない。実 Cloudflare API、deploy、repository setting、Environmentは変更していない。
