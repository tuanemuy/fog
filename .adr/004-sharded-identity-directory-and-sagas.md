# ADR-004: Identity Directoryを秘密鍵付きで分割し、DO間操作をsagaにする

## ステータス

承認済み

## コンテキスト

login前は`userId`がないため、メールまたはSSO identityから利用者を解決する
directoryが必要である。単一global objectはボトルネックになり、生のcredentialを
object nameへ使うと個人情報が漏れる。Directory、Account Home、User Data間に
分散transactionはない。

## 決定

request Workerだけが持つ世代付きsecretでcanonical credentialをHMAC-SHA-256し、
固定bucketのIdentity Directory Durable Objectへ写像する。canonical値、HMAC値、
object locatorを公開入力・URL・ログへ出さない。

Account Homeがstable operation ID、phase、epoch、全locatorを保持し、
Directory reservation、User Data初期化、mapping有効化、Account Home有効化を
再開可能なsagaとして進める。同時競合はactive mappingまたは最小operation IDへ
収束させ、敗者を冪等補償する。

rotationはoperator-only経路で全bucketをcheckpoint scanし、active世代へ再写像する。
全previous mappingとreverse locatorが0件になるまで旧鍵を破棄しない。退会は
Account Homeのtombstone/epochを先に確定し、User Data削除確認後にmappingを消す。

## 検討した代替案

- 単一Directory DO: throughputと可用性が一箇所へ集中する。
- 生メールをDO名に使う: object metadataから個人情報を推測できる。
- request側で補償状態を持つ: retryやプロセス終了でsaga状態を失う。

## 影響

- credential lookupを水平分割しながら一意性とPII耐性を保てる。
- 分散sagaの一時状態、決定順reservation、補償、rotation scanを運用する必要がある。
- Domainはcredentialの業務不変条件を持ち、routing/bucket/checkpointはadapterへ閉じる。
