# ADR — PR #54: refactor: replace instanceof-based error guards with structural checks

## ADR-001: mapDbError のパススルー判定を instanceof ApplicationError から isCodedError に置き換え、business kind の素通しを受け入れる

### Status
Proposed → `.adr/017` に昇格

### Context
`mapDbError` は D1 アダプター内で発生した例外のうち「既に契約化されたエラー」を素通しし、それ以外を `SystemError(DATABASE_ERROR)` に畳む。旧実装の判定は `instanceof ApplicationError` で、本PRの構造チェック化に伴い `isCodedError` に置き換えた。これにより素通しの範囲が `BusinessRuleError`（domain 層、`kind: "business"`）まで広がり、reconstruct 内の整合性障害が包み忘れられた場合の故障モードが「5xx への畳み込み」から「クライアント可視 422」に変わる。レビューで3ラウンドにわたり別角度から再指摘された（R1 / R2 / R6 / R8）。

### Decision
`isCodedError` によるパススルーを維持する。business のみ畳み戻す特殊分岐は設けない。緩和は次の2点で行う: (1) reconstruct 内の想定内壊れは `RehydrationError`（CodedError 非継承）で表現し、`mapDbError` が `SystemError(DATABASE_ERROR)` へ degrade することを統合テストで固定（helpers.integration.test.ts）。(2) 各リポジトリは corrupt-row の適合テスト（`isBusinessRuleError === false` の pin を含む）を持つ義務を負う — 参照実装は userRepository.integration.test.ts。義務が prose のみである限界は helpers.ts のコメントに明記済み。

### Consequences
- kind ベースの一様な素通しにより、アダプターがレイヤー例外の系譜を知る必要がなくなる（構造チェック化の趣旨と一致）。
- reconstruct が新設され適合テストを持たない場合、整合性障害がログなし 422 で漏れる余地が残る。機械的強制はなく、レビュー時のチェック項目である。
- 素通し範囲の変更（business を含む）は本 ADR が記録であり、コード側の挙動は上記2テストで固定されている。
