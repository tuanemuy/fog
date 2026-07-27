# ADR-006: usecaseはDO内で実行し、Worker RPCは値だけを運ぶ

## ステータス

承認済み

## コンテキスト

repository、Unit of Work callback、SQLite transaction capabilityはWorker RPCを
越えられない。request Workerでusecaseを実行してremote repositoryを注入すると、
application transactionと実際のDO transactionが一致しない。custom error instanceも
既存の構造的error contractを保証しない。

## 決定

User Data、Identity Directory、Account Homeのapplication usecaseは、その状態を
所有するDO内で実行する。semantic commandのcommitはDO内の同期adapterだけが行う。

RPCはversionedなprimitive DTOと
`{ ok: true, value } | { ok: false, error: SerializedError }`だけを返す。
repository、closure、transaction capability、custom error instanceを境界外へ出さない。
request Workerは認証、routing、複数authorityの公開DTO合成を担当する。

## 検討した代替案

- request Workerで全usecaseを実行する: transaction境界がremote callへ分断される。
- RPCでrepository風APIを公開する: 呼出側がatomicityを誤認しやすい。
- platformの例外伝搬へ依存する: error codeと公開redactionを安定させられない。

## 影響

- application処理とSQLite transactionの境界が明確になる。
- DIと公開DTO合成はrequest/state Workerに分かれる。
- RPC contract、version互換、serialized error mappingを維持する必要がある。
