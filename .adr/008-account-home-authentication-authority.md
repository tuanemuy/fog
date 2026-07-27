# ADR-008: Account Homeを認証とsessionのオンライン権威にする

## ステータス

承認済み

## コンテキスト

Directory mappingだけでloginを成立させると、signupの部分失敗、退会中、古いPITR
mapping、credential変更後のsessionを区別できない。署名済みtokenだけでは、
複数objectに跨る現在状態を反映した失効もできない。

## 決定

Account Homeはaccount status、operation phase、credential reverse locator、
operation/session epochのcanonical authorityとする。

loginはDirectory lookupとpassword verifyの後、Account Homeが`active`であり、
locatorとepochが現在値に一致することを必ず確認する。session tokenは発行時の
`sessionEpoch`を署名し、すべてのprotected execution pointが現在のAccount Homeと
照合する。password reset、link/unlink、deletionはoperation単位でepochを一度だけ
進め、古いtokenを拒否する。Account Homeが利用できない場合はfail closedにする。

## 検討した代替案

- Directory mappingを認証権威にする: pending/deleting/古いmappingを区別できない。
- session TTLだけで失効を待つ: credential変更や退会の反映が遅れる。
- 各機能が別々にauthorityを照合する: guard漏れと判定差が生まれる。

## 影響

- 部分失敗と古い復旧データだけでは認証が成立しない。
- protected requestごとにAccount Home RPCが1回必要になる。
- Account Homeの可用性を認証可用性より優先せず、安全側へ倒す。
