# Cloudflare デプロイ完了台帳

## 全体目標と現在地

作業場所は `.goal-implement/cloudflare-deploy/`。元の依頼は本スレッドの active goal と [brief.md](brief.md)。品質目標は extremely well。

更新: 2026-09-06T07:14:38+09:00。C4最終reworkを独立PASSで受け入れ、資格情報不要の実装・文書・検証を完了。done 3 / 7、review 0、blocked 0。Git履歴と参照repoにも実domain/account値はなく、現在は外部resource設定と実deploy gate待ち。進捗停滞の目安は15分。

Manager が全体 goal と本台帳を管理し、Implementer は `phases/`、Verifier は `reviews/` の担当報告だけを更新する。`spec` / `spec-implement` スキルは使用しない。

## フェーズ

| フェーズ | 目的 | 依存 | 状態 |
| --- | --- | --- | --- |
| C0 | 現行実装、Git 履歴、参考 repo、Cloudflare 方式を調査して全体設計を確定 | なし | done |
| C1 | Cloudflare runtime・永続化・定期処理を実装し、ローカルで起動 | C0 | done |
| C2 | staging / production 設定、migration、hostname、secret 契約を実装 | C1 | done |
| C3 | main → staging と release → production の GitHub Actions を実装 | C2 | done |
| C4 | 運用文書、回帰修正、統合検証 | C1〜C3 | done |

## 完了項目

| ID | 要件 | Phase / 依存 | 観測できる完了条件と検証 | 状態 | 根拠・障害 |
| --- | --- | --- | --- | --- | --- |
| CF01 | Cloudflare 実行基盤 | C1 / C0 | Cloudflare のローカル runtime で Web の health と主要 route が起動し、production build が成功する。KDF は強度を保ったまま同時実行1・bounded queueで、過負荷を明示拒否する | done | [runtime PASS](reviews/C1-runtime.md)・[core PASS](reviews/C1-core.md) |
| CF02 | 環境別データと migration | C1,C2 / CF01 | staging / production が別 DB を参照し、各環境へ非対話で schema migration を適用できる。login の scrypt は write transaction 外で行い、retention/集合操作は bounded transaction とする。誤環境適用を設定と手順で防ぐ | in_progress | local [config PASS](reviews/C2-config.md)・[operations PASS](reviews/C2-operations.md)、実remote gate待ち |
| CF03 | 定期処理と外部連携 | C1,C2 / CF01,CF02 | 保持期限処理と復旧メール outbox が Cloudflare 上の仕組みで実行可能。OAuth/mail callback URL と secrets が環境別に定義される | in_progress | local C1/C2 PASS、実Email/OAuth/Cron gate待ち |
| CF04 | main → staging | C3 / CF01〜CF03 | `main` の更新を契機に checks・migration・deploy が走り、`staging-fog.${domain}` に対象 SHA が反映される workflow を静的/ローカル検証する | in_progress | local [workflow PASS](reviews/C3-workflow.md)・[provenance PASS](reviews/C3-provenance.md)、実GitHub gate待ち |
| CF05 | release → production | C3 / CF04 | Release Please PR merge 後、action 出力の tag/SHA を照合し、staging 合格済みの同じ SHA だけが承認後 `fog.${domain}` に反映される。通常の main push と任意 SHA dispatch では production deploy しない。部分失敗は release/tag/main/staging 記録を再検証して復旧できる | in_progress | local C3 PASS、実release/environment gate待ち |
| CF06 | 安全な設定と運用手順 | C2,C4 / CF01〜CF05 | 必要な Cloudflare/GitHub resources・permissions・secrets、初回設定、deploy 再実行、rollback/障害復旧が secret 値なしで文書化される | done | [C4 final PASS](reviews/C4-final.md)。PITR rebind、Release Please権限、secret削除、authority、運用文書を受入済み |
| CF07 | 統合品質 | C4 / CF01〜CF06 | typecheck、lint、format、unit/integration、Cloudflare build/config validation が成功し、必須機能に Node-only 未接続経路や仮実装が残らない | done | [C4 final PASS](reviews/C4-final.md)。65/65 hash、unit192、Node94、workerd8、両stage build/dry-run、actionlint、artifact scan PASS |

## 外部判断・設定待ち

- `${domain}` の実値と対象 Cloudflare zone。
- Workers Paid plan と Email Sending Beta の対象 account での利用可否。
- staging / production の remote libSQL database と credentials。
- production GitHub Environment の required reviewer。
- Release Please 用 GitHub App token / fine-grained PAT。default `GITHUB_TOKEN` を使う場合は生成PRのworkflow承認運用。

## 受け入れ履歴

- 2026-09-06T07:14:38+09:00: external gateをread-onlyで再照合。Git履歴と参照`hollow`のCloudflare/Pulumi設定は`example.com` / `REPLACE_WITH_CF_ACCOUNT_ID`のみ。remote GitHub Environments、Actions variables/secretsは0、Actions PR作成許可false、Cloudflare CLI未認証、必要なprocess envはunset、Turso CLI未導入。外部変更は行わず、実domain/account/credentials/approverの入力待ちを維持。
- 2026-09-06T07:10:00+09:00: C4 final reworkを受け入れ。[final review](reviews/C4-final.md)はWorker settingsのresult欠落/null/array/primitive/malformed/hostile応答をfail closed、valid objectと初回404だけをPASSする独立matrix 9/9、focused112、unit192、65/65 manifest digest `b5dc067144dd3cedc29d2f182fa5a2935880804c7ff9d9c5ce032f4d452fef3c`を確認。前回full Node94/workerd8/両stage build-dry-run/actionlint/artifact scanも変更範囲照合で継承し、CF06/CF07とC4をdone。外部resource/実deploy gateはCF02〜CF05に残す。
- 2026-09-06T06:42:00+09:00: C4 reworkはPITR identity移管、Release Please初回権限、AI secret削除と文書warningを解消し、65-file manifestと全local checksをPASS。[final review](reviews/C4-final.md)は既存Worker settings APIの`{success:true}` result欠落をauthority checkが受理するfail-openを独立再現したため、response schema厳格化を再差し戻し。
- 2026-09-06T06:12:08+09:00: C4初回64-file manifestと全local checksはPASSしたが、[quality review](reviews/C4-quality.md) / [completion review](reviews/C4-completion.md) がPITR cloneのidentity移管、現repository設定でのRelease Please初回権限、`FOG_AI_CLIENTS`解除時のstale Worker secretをFAIL。Cloudflare authorityの実検証前にDB migrationする部分状態と文書warningも含めC4へ差し戻し。
- 2026-09-06T05:42:00+09:00: C3をlocal範囲で受け入れ。[workflow](reviews/C3-workflow.md)はcurrent Action pins/permissions/multi-job/actionlint、[provenance](reviews/C3-provenance.md)はpagination/latest/prerelease/TOCTOU/strict境界をPASS。62/62 hash一致。実GitHub Environment/deployment/Cloudflare endpoint gateをC4へ残す。
- 2026-09-06T05:29:00+09:00: C3差戻し修正候補を受領。multi-job/attempt-aware selection、bounded same-origin pagination、最新deployment/status、prerelease拒否、approval後完全再照合、strict repo/host、current Action pins/issues権限を実装。focused60、unit182、Node94、workerd8、actionlint、両stage dry-run PASS、新62対象hashを元Verifierへ再検証依頼。
- 2026-09-06T05:04:00+09:00: [workflow review](reviews/C3-workflow.md)と[provenance review](reviews/C3-provenance.md)は62/62一致、CF04 localとworkflow境界をPASSしたが、実multi-job応答拒否、旧action major、Release Please issues権限不足、prerelease受理、新failed deploymentから旧successへfallback、pagination未実装をFAIL。repository dot-segment/smoke host warningsも含めC3へ差し戻し。
- 2026-09-06T04:42:35+09:00: [C3完了候補](phases/C3.md)を受領。main checks→staging record/deploy/smoke→Release Please→release provenance→production approval/deployと既存release限定recoveryを実装。workflow/hostile24、actionlint、unit143、Node94、workerd8、両stage dry-run PASS、62対象hashを2系統Verifierへ引継ぎ。
- 2026-09-06T04:24:00+09:00: C2を資格情報不要範囲で受け入れ。[config](reviews/C2-config.md)はprovenance v2/exact config/両stage build-dry-run、[operations](reviews/C2-operations.md)はsecret hostile matrixとmigration atomic/concurrent/clock-skew/SIGKILL recoveryをPASS。54/54 hash一致。CF02/03は実remote/Email/OAuth gateを残し、C3へ移行。
- 2026-09-06T04:13:00+09:00: C2残存修正候補を受領。sensitive child出力をOS discard、server+client provenance v2、marker/bootstrap+migration全体の単一write transactionを実装。focused42、unit122、Node94、workerd8、両stage fresh build/dry-run PASS、新54対象hashを独立最終確認へ引継ぎ。
- 2026-09-06T03:55:00+09:00: C2再レビューは元blockerの大半をPASS。残存FAILは (1) secret-bearing child outputのJSON escape/prefix関係でredaction suffix漏洩、(2) provenanceがserverだけをhashしWrangler upload対象client assets改変を許可。migration leaseの固定10分/renewなしも警告。secret child outputを非公開化しclient treeをsymlink/hardlink含めdigest化、lease保証を補強するため差し戻し。
- 2026-09-06T03:38:00+09:00: C2差戻し修正候補を受領。独立DB authority/marker/lease、全side-effect preflight、exact config、source→artifact provenance、safe FS、stdin-only secret/allowlist child env、abort cleanupを実装。focused38、unit118、Node94、workerd8、両stage build/dry-run PASS、54対象hashを元Verifierへ再検証依頼。
- 2026-09-06T03:01:00+09:00: [C2 config review](reviews/C2-config.md)と[operations review](reviews/C2-operations.md)は50/50一致と通常系checksをPASSしたが、DB identity自己承認、全preflight/AI schema不足、OAuth pair/sender drift、runtime secretのchild env複製、abort/cleanup不足、config flags/date/workers_dev drift、stale bundle provenance欠如をFAIL。symlink追随も含めC2へ差し戻し。
- 2026-09-06T02:46:33+09:00: [C2完了候補](phases/C2.md)を受領。deterministic stage config、stage/DB/URL/callback guard、明示migration、stdin secret bulk、preflightを実装。両stage build/dry-run、unit96、Node94、workerd8、artifact leak scan PASS、50対象hashを環境契約とmigration/secretの2系統Verifierへ引継ぎ。
- 2026-09-06T02:31:00+09:00: C1最終再検証を受け入れ。[runtime](reviews/C1-runtime.md)は41/41 hash、workerd/build/dry-run/bundle scan PASS。[core](reviews/C1-core.md)はroot marker全partial境界、individual/generic/retention、late child、owner隔離、row/statement上限、unit80/Node94をPASS。CF01はdoneを維持し、CF02/CF03の外部接続契約をC2へ移行。
- 2026-09-06T02:22:00+09:00: topic root markerを全cleanup前に行予算から予約し、restorable topic直接DELETEを除去、共通purging+children0最終DELETEへ統一した修正候補を受領。unit80、Node integration94、focused24、workerd8、checks/build/dry-run PASS、新41対象hashを最終独立確認へ引継ぎ。
- 2026-09-06T02:13:00+09:00: runtime最終照合PASS。core最終照合は既存B-CORE-003検証をPASSしたが、topic rootをmarkせずchild markerから処理中を推論するため、最後のchild削除commitとroot marker追加の間にpurging=0となり、復元が成功して一部childだけのactive topicになるgapをrowLimit1で再現。generic emptyTrash/retentionへの同型影響を含めC1へ再差し戻し。
- 2026-09-06T02:03:00+09:00: B-CORE-003修正候補を受領。purging不可逆境界、topic descendant再検査、個別/group hard-deleteのbounded child→parent protocol、typed partial/conflictと処理中UIを実装。unit79、Node integration92、workerd8、focused data22、checks/build/dry-run/bundle scan PASS、新41対象hashを最終再レビューへ引継ぎ。
- 2026-09-06T01:40:00+09:00: runtime再検証は41/41一致、secure DB URLと全回帰PASS。core再検証は元2件をPASSしたが、topic group restoreがpurging documentをactive+purgingにし後続purgeで消失すること、topic hard-deleteがhidden child+501 revisionをcascadeしてrow上限を迂回するB-CORE-003を実DB再現。group操作とpurgingの状態遷移をC1へ再差し戻し。
- 2026-09-06T01:31:00+09:00: C1差戻し3件の修正候補を受領。TLS-only DB URL/token、cascade子行のpurging state/bounded batch、typed partial resultとUI invalidateを実装。unit78、Node integration88、workerd8、checks/build/dry-run/bundle scan PASS、41対象hashを同じVerifier2名へ再検証依頼。
- 2026-09-06T01:12:00+09:00: [runtime review](reviews/C1-runtime.md)と[core review](reviews/C1-core.md)を受領。両者がCF01のcustom entry/RSC/ALS/KDF admission/build/dry-runをPASSとしCF01をdone。CF02は (1) whitespace token/平文DB URL/tls=0受理、(2) cascade子行がtransaction上限外、(3) emptyTrash部分commit後にUI再取得せず全件削除契約と不整合、の3件でFAILしC1へ差し戻し。
- 2026-09-06T00:57:00+09:00: [C1完了候補](phases/C1.md)を受領。remote web client、fetch+scheduled、Email binding、bounded KDF/login/retentionを実装。unit76、Node integration86、workerd8、両build、Wrangler dry-run、bundle scanのPASSと30対象hashを独立レビューへ引き継ぎ、実装担当の書き込み停止を確認。
- 2026-09-06T00:33:08+09:00: C0再レビューPASS。初回所見5件が設計とCF01/CF02/CF05に反映されたことを確認し、C0を受け入れ。外部判断待ちを実在するaccount/domain設定へ整理し、C1へ移行。
- 2026-09-06T00:30:00+09:00: [C0 独立レビュー](reviews/C0.md)は方式の大枠を支持したが、scrypt の128MB超過リスク、write transaction中のKDF、unbounded retention、production SHA照合、release部分失敗復旧を必須修正としてFAIL。設計とCF01/CF02/CF05へ反映し再レビュー。
- 2026-09-06T00:25:00+09:00: [C0 調査報告](phases/C0.md)を受領。Workers + environment 別 remote libSQL、fetch + Cron、Workers mail adapter、Release Please を採用候補として [design.md](design.md) に反映し、独立レビューへ移行。

- 2026-09-06T00:11:46+09:00: 新しい依頼として既存 `.goal-implement/` の製品実装台帳から分離し、`cloudflare-deploy/` を開始。C0 を Implementer に委譲。
