# 017. mapDbError は isCodedError で素通しし、business kind も畳み戻さない

## ステータス

承認済み

## コンテキスト

`mapDbError` は D1 アダプター内で発生した例外のうち「既に契約化されたエラー」を素通しし、それ以外を `SystemError(DATABASE_ERROR)` に畳む。PR #54 の構造チェック化（`.adr/016`）で判定を `instanceof ApplicationError` から `isCodedError` に置き換えた結果、素通しの範囲が `BusinessRuleError`（domain 層、`kind: "business"`）まで広がった。reconstruct 内の整合性障害が `RehydrationError` に包み忘れられた場合の故障モードは、旧実装の「5xx への畳み込み（ログあり）」から「クライアント可視 422（ログなし）」に変わる。

## 前提

- ユニットオブワークは usecase コールバックを `mapDbError` の外で実行するため、`mapDbError` のスコープ内に `BusinessRuleError` の正当な生産者は存在しない。
- reconstruct 内の想定内の壊れは `RehydrationError`（`CodedError` 非継承）で表現される。

## 決定

`isCodedError` による一様な素通しを維持し、`kind: "business"` だけ `SystemError` へ畳み戻す特殊分岐は設けない。緩和は次の2点で行う。

1. `RehydrationError` が `SystemError(DATABASE_ERROR)` へ degrade することを統合テストで固定する（`helpers.integration.test.ts`）。
2. reconstruct を持つ各リポジトリは corrupt-row の適合テスト（`isBusinessRuleError === false` の pin を含む）を持つ義務を負う。参照実装は `userRepository.integration.test.ts`。この義務が prose である限界は `helpers.ts` のコメントに明記する。

## 検討した代替案

- **`kind: "business"` のみ `SystemError(DataIntegrityError)` へ畳み戻す** — fail-closed になるが、アダプターがレイヤー例外の系譜を知る特殊分岐であり、構造チェック化（kind ベースの一様な扱い）の趣旨に反する。不採用。
- **リポジトリ横断の conformance テスト基盤を新設して義務を機械化する** — 現時点で reconstruct を持つリポジトリは1つで、基盤のコストが便益に勝る。リポジトリが増えた時点で再検討。

## 影響

- アダプターはレイヤー例外の系譜を知らずに済み、契約化されたエラーの翻訳規則が一様になる。
- 新設リポジトリが適合テストを持たない場合、整合性障害がログなし 422 で漏れる余地が残る。機械的強制はなく、レビュー時のチェック項目である。前提（reconstruct の壊れは `RehydrationError` で表現する）が崩れたら本 ADR は再検討の対象になる。
