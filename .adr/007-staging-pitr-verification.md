# ADR-007: PITRはstaging smoke、localはwrapper contractで検証する

## ステータス

承認済み

## コンテキスト

SQLite-backed Durable ObjectsのPITRはlocal workerdで利用できない。Directoryと
User Dataは別objectであり、単一objectのrestoreだけではidentity全体の整合も
保証できない。

## 決定

local/CIはPITR wrapperの入力、対象制限、error変換、receipt、undo、migration・
export・deleteとの契約を検証する。実bookmark/restore/verify/undoは、保護された
staging環境のdisposable User DataとIdentity Directoryだけで行う。

Account Homeはrestore対象外とし、toolingが対象指定を拒否する。Directory/User Dataの
復旧前後には、現在のAccount Homeにある非PII tombstoneとepochを照合し、
削除済みcredentialやdataを再有効化しない。実行記録は対象、commit、時刻、
照合結果、有効期限、undoを含むfail-closedなrelease evidenceにする。

## 検討した代替案

- local mockだけでPITR完了とする: platformの実restore経路を検証できない。
- Account Homeも過去へ戻す: 現在の削除・session authorityを巻き戻す危険がある。
- production objectでsmokeする: 非破壊性と隔離を保証できない。

## 影響

- CIで実行不能なplatform機能を、実環境の明示的release gateとして扱える。
- staging資格情報、承認、disposable target、期限付き証跡が必要になる。
- gate未完了でもlocal品質ゲートは通るが、canonical deploy preflightはfail closedになる。
