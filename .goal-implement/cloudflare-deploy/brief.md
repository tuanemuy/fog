# Cloudflare デプロイ対応

## 目的と入力

fog を Cloudflare 上で運用できる構成にし、通常の開発と本番リリースを分離する。元の依頼は本スレッドの goal `01a0721b-ee8b-73f1-b712-3e3d8000ad0b`。参考実装は `https://github.com/tuanemuy/hollow/blob/` と fog の Git 履歴だが、現在の要件と Cloudflare の公式仕様を優先する。

## 必須範囲

- `main` にマージされた revision を `staging-fog.${domain}` へ自動デプロイする。
- release PR などの明示的な昇格操作を経た revision だけを `fog.${domain}` へデプロイする。
- staging と production の設定、データ、secret、hostname を分離し、同じ revision を昇格できる仕組みにする。
- 現在の Web、DB migration、定期処理、認証 callback、復旧メールを Cloudflare の実行制約に合わせる。
- GitHub Actions、Cloudflare 設定、必要な環境変数と初回セットアップ・障害時の再実行手順をリポジトリに残す。
- 型検査、lint、format、unit/integration、build、Cloudflare 向けローカル実行と deploy 設定の検証を行う。

## 対象外

- この作業中に実 Cloudflare account、DNS、GitHub repository secrets を無断で作成・変更すること。
- 利用者の明示的な資格情報や公開許可なしで staging / production を実際に公開すること。
- Cloudflare 対応と無関係なプロダクト機能変更。

## 制約

- CLAUDE.md の型安全性、hexagonal architecture、境界検証、UoW、エラー契約を維持する。
- Cloudflare を新しい具体的な deployment target として採用する。既存の Node 固有実装を残すか置き換えるかは、Cloudflare 上の Web・永続化・定期処理・メール・運用が端から端まで成立する方式で決める。
- GitHub Actions は production への意図しない昇格を防ぎ、staging と production の同時実行・競合を制御する。
- secret 値をコミットしない。環境別の変数名、設定先、必要権限だけを文書化する。

## 仮定と未決事項

- `${domain}` は利用者が所有する Cloudflare zone の apex domain を表す。実値は未提示のため、リポジトリには secret または初回セットアップ入力として扱う。
- 「release PR」は、その PR が production へ反映する revision を人がレビューでき、マージ後に production deploy が一度だけ走る仕組みを意味すると仮定する。具体方式は Git 履歴・参考実装・公式機能を比較して決める。
- Cloudflare / GitHub の account ID、API token、zone、DB、OAuth、mail の本番資格情報は未確認。資格情報なしで可能な実装とローカル検証を先に完了する。
- 実 Cloudflare への初回 provisioning と hostname 到達確認には利用者の資格情報・domain 値・外部変更許可が必要になる可能性がある。
