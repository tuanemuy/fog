# Inventory — test

生成元: spec/testcases/（最終同期: 2026-08-06）

testcases 側にテストケース ID の記載はないため、全行 `TC-{テストケースファイルの slug}-{連番3桁}` で新規採番した。**slug はファイル名の basename である** — 多くはユースケース名と一致するが、`post_memo` / `recent_memos` / `update_memo` のようにユースケース名ではないものも、`outboxDelivery` のようにどのユースケースにも属さないものもある。連番は**採番時の**テーブルの行順（`spec/testcases/{パス}` 内の上から下）に対応する。定義場所の `#L{n}` は当該テストケース行の行番号（Read の offset で直接開ける）。

`spec/testcases/async/` は**ユースケースではなくカテゴリーに対応するディレクトリ**であり、対応先は `spec/async/index.md`（DO ローカル Outbox の配送機構）である。

**ID の欠番規約**: 削除したケースの連番は欠番のまま残し、後続を繰り上げない。**本台帳は見出しを持たない単一の表である** — 新設は同じ slug の行群の末尾に append し（新しい slug は表全体の末尾に append する）、新しい表を設けない。連番が飛んでいるのは意図した欠番であり、詰めると #10 / #13 が参照する ID が別のケースを指すようになる（`spec/inventory/domain.md` の `DOM-*` にも同じ規約が掛かる）。したがって**連番と現在の行順は一致しないことがある** — 位置の権威は `#L{n}` である。

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| TC-exportAllData-001 | 基本構成のエクスポート | spec/testcases/export/exportAllData.md#L9 | zip（filename/contentType 正）が返り、ルートに index.md・memos/ 日別2ファイル・topics/{slug}/（index.md + ドキュメント2ファイル）が含まれれば PASS |
| TC-exportAllData-002 | マニフェスト index.md | spec/testcases/export/exportAllData.md#L10 | frontmatter に type/exportedAt/timezone/counts、本文に対象範囲・非対象の説明があれば PASS |
| TC-exportAllData-003 | 同日メモの日別ファイル | spec/testcases/export/exportAllData.md#L11 | 同日3メモが1ファイルに postedAt 昇順・`## HH:mm (memoId)` 見出し（同一分も別見出し）で並べば PASS |
| TC-exportAllData-004 | timezone 基準の日別グルーピング | spec/testcases/export/exportAllData.md#L12 | UTC 同日でも指定 TZ で別日のメモが別の日別ファイルに分かれれば PASS |
| TC-exportAllData-005 | 本文エスケープなし | spec/testcases/export/exportAllData.md#L13 | `##` で始まる行を含む本文がエスケープなしでそのまま出力されれば PASS |
| TC-exportAllData-006 | トピック index.md の frontmatter | spec/testcases/export/exportAllData.md#L14 | type/topicId/name（引用符付き）/archived/createdAt の frontmatter と description 本文が出力されれば PASS |
| TC-exportAllData-007 | description null のトピック | spec/testcases/export/exportAllData.md#L15 | トピックメタが frontmatter のみ・本文なしになれば PASS |
| TC-exportAllData-008 | ドキュメントファイルの出力 | spec/testcases/export/exportAllData.md#L16 | frontmatter に sources（memoId/postedAt/日別ファイルへの相対 file パス）が載り、本文は最新リビジョンのみなら PASS |
| TC-exportAllData-009 | ソフトデリート済み出典の出力 | spec/testcases/export/exportAllData.md#L17 | 該当 source が memoId + deleted:true のみ（file/postedAt なし）で出力されれば PASS |
| TC-exportAllData-010 | ハードデリート済み出典の非出力 | spec/testcases/export/exportAllData.md#L18 | 該当出典が sources にエントリごと現れなければ PASS（ADR-003） |
| TC-exportAllData-011 | 完了済みトピックの包含 | spec/testcases/export/exportAllData.md#L19 | archived トピックもエクスポートされ frontmatter に archived:true が出れば PASS（ADR-002） |
| TC-exportAllData-012 | ゴミ箱・リビジョン履歴の除外 | spec/testcases/export/exportAllData.md#L20 | ゴミ箱内項目が現れず、各項目は最新リビジョンのみ・counts もゴミ箱除外なら PASS |
| TC-exportAllData-013 | ドキュメント0件トピック | spec/testcases/export/exportAllData.md#L21 | ドキュメント0件でも topics/{slug}/index.md が出力されれば PASS |
| TC-exportAllData-014 | 全データ0件の空アーカイブ | spec/testcases/export/exportAllData.md#L22 | counts 全0の index.md のみの zip が正常応答として返り、memos/・topics/ が出なければ PASS |
| TC-exportAllData-015 | メモ0件・トピックあり | spec/testcases/export/exportAllData.md#L23 | memos/ が出力されず topics/ は出力されれば PASS |
| TC-exportAllData-016 | スラッグの禁止文字除去 | spec/testcases/export/exportAllData.md#L24 | `/ \ : * ? " < > \| #` と制御文字が除去されたディレクトリ名になれば PASS |
| TC-exportAllData-017 | スラッグの正規化 | spec/testcases/export/exportAllData.md#L25 | NFC 正規化・前後空白除去・空白連続の `-` 1つ置換が行われれば PASS |
| TC-exportAllData-018 | スラッグ導出結果が空 | spec/testcases/export/exportAllData.md#L26 | スラッグが `untitled` になれば PASS |
| TC-exportAllData-019 | 先頭末尾の `.`/`-` 除去 | spec/testcases/export/exportAllData.md#L27 | スラッグ先頭・末尾の `.` と `-` が除去されれば PASS |
| TC-exportAllData-020 | 50コードポイント境界（許容） | spec/testcases/export/exportAllData.md#L28 | ちょうど50コードポイントの名前が切り詰めなしでスラッグになれば PASS |
| TC-exportAllData-021 | 51コードポイント以上の切り詰め | spec/testcases/export/exportAllData.md#L29 | サロゲートペア込みでコードポイント単位50文字に切り詰められれば PASS |
| TC-exportAllData-022 | 同名トピックのスラッグ衝突 | spec/testcases/export/exportAllData.md#L30 | createdAt 昇順で1件目は素のスラッグ・2件目以降 `-2`, `-3` … になれば PASS |
| TC-exportAllData-023 | 同一トピック内の同タイトル衝突 | spec/testcases/export/exportAllData.md#L31 | 同一階層でのみ連番が付き、別トピック配下の同名には付かなければ PASS |
| TC-exportAllData-024 | 切り詰め後・連番付与後の再衝突 | spec/testcases/export/exportAllData.md#L32 | 再衝突も同一規則で解決され ExportArchive.files の path が一意になれば PASS |
| TC-exportAllData-025 | 日本語スラッグ | spec/testcases/export/exportAllData.md#L33 | 非 ASCII 文字が除去されず日本語のままスラッグになれば PASS |
| TC-exportAllData-026 | ファイル順序とエンコーディング | spec/testcases/export/exportAllData.md#L34 | files が path 辞書順ソート・全ファイル UTF-8・改行 LF なら PASS |
| TC-exportAllData-027 | レンダリングの決定性 | spec/testcases/export/exportAllData.md#L35 | 同一データ・同一 exportedAt/timezone の2回実行がバイト同一なら PASS |
| TC-exportAllData-028 | timezone 空文字 | spec/testcases/export/exportAllData.md#L36 | BusinessRuleError(InvalidTimezone) となり ExportSourceReader が呼ばれなければ PASS |
| TC-exportAllData-029 | timezone 解決不能 | spec/testcases/export/exportAllData.md#L37 | IANA 解決不能な値で BusinessRuleError(InvalidTimezone) なら PASS |
| TC-exportAllData-030 | userId 形式不正 | spec/testcases/export/exportAllData.md#L38 | 値オブジェクト構築で ValidationError になれば PASS |
| TC-exportAllData-031 | 孤児ドキュメントの防衛検査 | spec/testcases/export/exportAllData.md#L39 | topics に不在の topicId を持つ不整合で BusinessRuleError(OrphanDocument)・zip 非生成なら PASS |
| TC-exportAllData-032 | ExportFile パス不変条件 | spec/testcases/export/exportAllData.md#L40 | 不正 path での構築が BusinessRuleError(InvalidArchivePath) になれば PASS |
| TC-exportAllData-033 | ExportArchive パス重複不変条件 | spec/testcases/export/exportAllData.md#L41 | path 重複での構築が BusinessRuleError(DuplicateArchivePath) になれば PASS |
| TC-exportAllData-034 | 読み取り DB 障害 | spec/testcases/export/exportAllData.md#L42 | SystemError(DatabaseError) となりレンダリング・zip 化が行われなければ PASS |
| TC-exportAllData-035 | zip エンコード失敗 | spec/testcases/export/exportAllData.md#L43 | SystemError(ArchiveEncodingError) になれば PASS |
| TC-exportAllData-036 | テナント分離 | spec/testcases/export/exportAllData.md#L44 | アーカイブに認証ユーザーのデータのみ含まれれば PASS |
| TC-exportAllData-037 | AI トークンから呼び出し不可 | spec/testcases/export/exportAllData.md#L45 | 公開インターフェースに含まれず AI から呼び出せなければ PASS（Web UI 専用） |
| TC-exportAllData-038 | 読み出し上限の超過 | spec/testcases/export/exportAllData.md#L46 | 総バイト数が上限を超えると SystemError 系で拒否され、部分的なアーカイブも返らなければ PASS |
| TC-exportAllData-039 | 実行位置の分割 | spec/testcases/export/exportAllData.md#L47 | 読み出しが DO 内の1回の transactionSync で完結し、render / zip が request Worker で回れば PASS |
| TC-approveAiClientAuthorization-001 | 承認の正常系 | spec/testcases/identity/approveAiClientAuthorization.md#L9 | active な接続（lastUsedAt:null, version:0）が作成され connectionId が返り、作成時点の resetVersion が createdAtResetVersion に写されれば PASS |
| TC-approveAiClientAuthorization-002 | クライアント名の trim | spec/testcases/identity/approveAiClientAuthorization.md#L10 | 前後空白付き名が trim 後の名前で接続作成されれば PASS |
| TC-approveAiClientAuthorization-003 | クライアント名100文字境界 | spec/testcases/identity/approveAiClientAuthorization.md#L11 | ちょうど100文字で正常に接続が作成されれば PASS |
| TC-approveAiClientAuthorization-004 | クライアント名101文字 | spec/testcases/identity/approveAiClientAuthorization.md#L12 | BusinessRuleError となり接続が作成されなければ PASS |
| TC-approveAiClientAuthorization-005 | クライアント名空・空白のみ | spec/testcases/identity/approveAiClientAuthorization.md#L13 | trim 後非空違反で BusinessRuleError・接続非作成なら PASS |
| TC-approveAiClientAuthorization-006 | 同名クライアントの再承認 | spec/testcases/identity/approveAiClientAuthorization.md#L14 | 新しい connectionId で別接続が作成されれば PASS（1回の許可＝1接続） |
| TC-approveAiClientAuthorization-007 | 失効後の再認可 | spec/testcases/identity/approveAiClientAuthorization.md#L15 | 新接続が作成され既存 revoked 接続が不変なら PASS |
| TC-approveAiClientAuthorization-008 | insert DB 例外 | spec/testcases/identity/approveAiClientAuthorization.md#L16 | SystemError・ロールバックで接続が作成されなければ PASS |
| TC-changePassword-001 | 変更の正常系 | spec/testcases/identity/changePassword.md#L7 | 認証情報側の検証材料が新パスワードのものへ差し替わり、未使用リセットトークンが無効化され、sessionEpoch と対象クレデンシャルの credentialVersion の両方が前進して void 正常終了なら PASS |
| TC-changePassword-002 | 新パスワード8文字境界 | spec/testcases/identity/changePassword.md#L8 | ちょうど8文字で正常終了すれば PASS |
| TC-changePassword-003 | 新パスワード128文字境界 | spec/testcases/identity/changePassword.md#L9 | ちょうど128文字で正常終了すれば PASS |
| TC-changePassword-004 | 新パスワード7文字 | spec/testcases/identity/changePassword.md#L10 | BusinessRuleError(PasswordTooWeak)・パスワード不変なら PASS |
| TC-changePassword-005 | 新パスワード129文字 | spec/testcases/identity/changePassword.md#L11 | BusinessRuleError(PasswordTooWeak) なら PASS |
| TC-changePassword-006 | 現在パスワード不一致 | spec/testcases/identity/changePassword.md#L12 | ValidationError("CURRENT_PASSWORD_MISMATCH")・パスワード不変なら PASS |
| TC-changePassword-007 | 同一値への変更許容 | spec/testcases/identity/changePassword.md#L13 | 現在と同じ新パスワードでも正常終了すれば PASS |
| TC-changePassword-008 | ユーザー不在 | spec/testcases/identity/changePassword.md#L14 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-changePassword-009 | SSO 専用アカウントへの防衛的拒否 | spec/testcases/identity/changePassword.md#L15 | BusinessRuleError(PasswordNotSupported) なら PASS |
| TC-changePassword-010 | 二重変更の競合 | spec/testcases/identity/changePassword.md#L16 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-changePassword-011 | verify 計算失敗 | spec/testcases/identity/changePassword.md#L17 | SystemError なら PASS |
| TC-changePassword-012 | hash 失敗 | spec/testcases/identity/changePassword.md#L18 | SystemError なら PASS |
| TC-changePassword-013 | 認証情報側の DB 例外 | spec/testcases/identity/changePassword.md#L19 | SystemError・ロールバックで検証材料が差し替わらなければ PASS |
| TC-changePassword-014 | changeState pending 中のログイン | spec/testcases/identity/changePassword.md#L20 | 旧新どちらのパスワードもダミー材料へ倒れ ValidationError("INVALID_CREDENTIALS") なら PASS |
| TC-changePassword-015 | changeState advanced 中のログイン | spec/testcases/identity/changePassword.md#L21 | 値域3値のうち null でない値はどちらもダミー材料へ倒れれば PASS |
| TC-changePassword-016 | sessionEpoch の前進 | spec/testcases/identity/changePassword.md#L22 | 変更前に確立していた別セッションが次のリクエストで失効すれば PASS |
| TC-changePassword-017 | AI クライアント接続の非失効 | spec/testcases/identity/changePassword.md#L23 | パスワード変更では接続が active のまま残れば PASS |
| TC-changePassword-018 | 旧パスワード照合失敗のカウント | spec/testcases/identity/changePassword.md#L24 | 照合失敗が failedAttempts を進めれば PASS（ログイン失敗と同じカウンタ） |
| TC-changePassword-019 | nextAttemptAllowedAt 未到達の明示拒否 | spec/testcases/identity/changePassword.md#L25 | ValidationError("TOO_MANY_ATTEMPTS") で明示的に拒否され（ダミー材料へ倒さない）、検証材料が差し替わらなければ PASS |
| TC-changePassword-020 | 照合成功でのカウンタリセット | spec/testcases/identity/changePassword.md#L26 | failedAttempts が 0 に戻れば PASS |
| TC-changePassword-021 | 前進不能時の終端 | spec/testcases/identity/changePassword.md#L27 | 一様な終端に落ち記録が残り運用へエスカレーションされれば PASS（手順は #45） |
| TC-changePassword-022 | credentialVersion の前進 | spec/testcases/identity/changePassword.md#L28 | 完走後に新パスワードでログインでき、locator 側の credentialVersion が認証情報側と一致して到達性検査を通れば PASS |
| TC-changeTrashRetentionDays-001 | 変更の正常系 | spec/testcases/identity/changeTrashRetentionDays.md#L7 | trashRetentionDays 更新・version+1 で void 正常終了なら PASS |
| TC-changeTrashRetentionDays-002 | 最小値1境界 | spec/testcases/identity/changeTrashRetentionDays.md#L8 | retentionDays:1 で正常更新されれば PASS |
| TC-changeTrashRetentionDays-003 | 0 指定 | spec/testcases/identity/changeTrashRetentionDays.md#L9 | BusinessRuleError(InvalidTrashRetentionDays)・設定不変なら PASS |
| TC-changeTrashRetentionDays-004 | 負数指定 | spec/testcases/identity/changeTrashRetentionDays.md#L10 | BusinessRuleError(InvalidTrashRetentionDays) なら PASS |
| TC-changeTrashRetentionDays-005 | 非整数指定 | spec/testcases/identity/changeTrashRetentionDays.md#L11 | 1.5 で BusinessRuleError(InvalidTrashRetentionDays) なら PASS |
| TC-changeTrashRetentionDays-006 | NaN / Infinity 指定 | spec/testcases/identity/changeTrashRetentionDays.md#L12 | BusinessRuleError(InvalidTrashRetentionDays) なら PASS |
| TC-changeTrashRetentionDays-007 | 同一値への変更許容 | spec/testcases/identity/changeTrashRetentionDays.md#L13 | 現在値と同じ指定でも正常終了すれば PASS |
| TC-changeTrashRetentionDays-008 | SSO 専用アカウントでも変更可 | spec/testcases/identity/changeTrashRetentionDays.md#L14 | 認証方式に関わらず正常更新されれば PASS |
| TC-changeTrashRetentionDays-009 | 既存ゴミ箱項目への適用 | spec/testcases/identity/changeTrashRetentionDays.md#L15 | 変更後の値が既存のゴミ箱項目と以後のソフトデリート項目の双方に適用されれば PASS |
| TC-changeTrashRetentionDays-010 | ユーザー不在 | spec/testcases/identity/changeTrashRetentionDays.md#L16 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-changeTrashRetentionDays-011 | OCC 競合 | spec/testcases/identity/changeTrashRetentionDays.md#L17 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-changeTrashRetentionDays-012 | UserSettingsRepository.save DB 例外 | spec/testcases/identity/changeTrashRetentionDays.md#L18 | SystemError・ロールバックで保持日数も purge_after の再計算も反映されなければ PASS |
| TC-changeTrashRetentionDays-013 | purge_after の一括再計算 | spec/testcases/identity/changeTrashRetentionDays.md#L19 | 変更と同一トランザクションで全項目の purgeAfter が再計算され、最も早い期限で purge-trash の起床が張り直されれば PASS |
| TC-changeTrashRetentionDays-014 | 大量項目のチャンク分割 | spec/testcases/identity/changeTrashRetentionDays.md#L20 | 再計算がチャンクに分けて進められ、残件がある間は再計算フェーズが期限判定より先に完走すれば PASS |
| TC-denyAiClientAuthorization-001 | 拒否の正常系 | spec/testcases/identity/denyAiClientAuthorization.md#L9 | void 正常終了し、AiClientConnection が作られなければ PASS |
| TC-denyAiClientAuthorization-002 | 拒否後の一覧非表示 | spec/testcases/identity/denyAiClientAuthorization.md#L10 | listAiClientConnections に拒否した認可の接続が現れなければ PASS |
| TC-denyAiClientAuthorization-003 | プロトコル拒否応答はアダプター責務 | spec/testcases/identity/denyAiClientAuthorization.md#L11 | アダプターがエラーリダイレクトを返す（ユースケース責務外）ことが確認できれば PASS |
| TC-executePasswordReset-001 | リセットの正常系 | spec/testcases/identity/executePasswordReset.md#L7 | トークン消費・検証材料の差し替え・そのクレデンシャル宛の未使用トークンの一括無効化が行われ、出力が { userId } なら PASS |
| TC-executePasswordReset-002 | 新パスワード8文字境界 | spec/testcases/identity/executePasswordReset.md#L8 | ちょうど8文字で正常終了すれば PASS |
| TC-executePasswordReset-003 | 新パスワード128文字境界 | spec/testcases/identity/executePasswordReset.md#L9 | ちょうど128文字で正常終了すれば PASS |
| TC-executePasswordReset-004 | 7文字でトークン非消費 | spec/testcases/identity/executePasswordReset.md#L10 | PasswordTooWeak となりトークンが消費されなければ PASS |
| TC-executePasswordReset-005 | 129文字でトークン非消費 | spec/testcases/identity/executePasswordReset.md#L11 | PasswordTooWeak となりトークンが消費されなければ PASS |
| TC-executePasswordReset-006 | 要件違反失敗後の再実行 | spec/testcases/identity/executePasswordReset.md#L12 | 同じトークンで有効なパスワードなら成功すれば PASS（トークン浪費なし） |
| TC-executePasswordReset-007 | 不正・改ざんトークン | spec/testcases/identity/executePasswordReset.md#L13 | ValidationError("RESET_TOKEN_INVALID") なら PASS |
| TC-executePasswordReset-008 | 期限切れトークン | spec/testcases/identity/executePasswordReset.md#L14 | ValidationError("RESET_TOKEN_INVALID") なら PASS |
| TC-executePasswordReset-009 | 使用済みトークン | spec/testcases/identity/executePasswordReset.md#L15 | 再利用で ValidationError("RESET_TOKEN_INVALID") なら PASS（使い捨て） |
| TC-executePasswordReset-010 | 失敗原因の非区別 | spec/testcases/identity/executePasswordReset.md#L16 | 無効・期限切れ・使用済みが同一エラーで区別不能なら PASS |
| TC-executePasswordReset-011 | トークンの指すユーザー不在 | spec/testcases/identity/executePasswordReset.md#L17 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-executePasswordReset-012 | 検証材料を持たないクレデンシャルへの防衛的拒否 | spec/testcases/identity/executePasswordReset.md#L18 | BusinessRuleError(PasswordNotSupported)・パスワード未設定なら PASS |
| TC-executePasswordReset-013 | OCC 競合 | spec/testcases/identity/executePasswordReset.md#L19 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-executePasswordReset-014 | hash 失敗 | spec/testcases/identity/executePasswordReset.md#L20 | SystemError なら PASS |
| TC-executePasswordReset-015 | トークンストア障害 | spec/testcases/identity/executePasswordReset.md#L21 | SystemError なら PASS |
| TC-executePasswordReset-016 | 認証情報側の DB 例外 | spec/testcases/identity/executePasswordReset.md#L22 | SystemError・ロールバックで検証材料が差し替わらなければ PASS |
| TC-executePasswordReset-017 | 中間状態でのログイン | spec/testcases/identity/executePasswordReset.md#L23 | changeState が null でない間は旧新どちらのパスワードでもログインできなければ PASS |
| TC-executePasswordReset-018 | sessionEpoch の前進 | spec/testcases/identity/executePasswordReset.md#L24 | 完了前に確立していた別セッションが次のリクエストで失効すれば PASS |
| TC-executePasswordReset-019 | resetVersion 前進による自動失効 | spec/testcases/identity/executePasswordReset.md#L25 | 前回のリセット完了以降に作られた接続だけが revoked になれば PASS |
| TC-executePasswordReset-020 | 前進不能時の終端 | spec/testcases/identity/executePasswordReset.md#L26 | 一様な終端に落ち記録が残り運用へエスカレーションされれば PASS（手順は #45） |
| TC-executePasswordReset-021 | credentialVersion の前進 | spec/testcases/identity/executePasswordReset.md#L27 | 完走後に新パスワードでログインでき、locator 側の credentialVersion が認証情報側と一致して到達性検査を通れば PASS |
| TC-executePasswordReset-022 | 完了画面の認証文脈 | spec/testcases/identity/executePasswordReset.md#L28 | 出力の userId で新しいセッションが確立され、再ログインを挟まずに P-03 の必須導線を実行できれば PASS |
| TC-getCurrentUser-001 | メールのクレデンシャルのみのアカウント | spec/testcases/identity/getCurrentUser.md#L7 | userId/email/credentials/trashRetentionDays が返り credentials が {credentialId, kind, label, usableForLogin} の4フィールドなら PASS |
| TC-getCurrentUser-002 | SSO+メールのクレデンシャル集合 | spec/testcases/identity/getCurrentUser.md#L8 | credentials に2件返り kind:"sso" の label が provider 名なら PASS |
| TC-getCurrentUser-003 | 検証材料の非露出 | spec/testcases/identity/getCurrentUser.md#L9 | 出力 DTO に検証材料が含まれず credentialId は含まれれば PASS |
| TC-getCurrentUser-004 | SSO 主体情報の非露出 | spec/testcases/identity/getCurrentUser.md#L10 | 出力 DTO に provider/providerSubject が含まれなければ PASS |
| TC-getCurrentUser-005 | 保持日数の既定値 | spec/testcases/identity/getCurrentUser.md#L11 | 登録直後は trashRetentionDays:30 が返れば PASS |
| TC-getCurrentUser-006 | 保持日数変更の反映 | spec/testcases/identity/getCurrentUser.md#L12 | 変更後の値（例:1）が返れば PASS |
| TC-getCurrentUser-007 | セッション有効・ユーザー不在 | spec/testcases/identity/getCurrentUser.md#L13 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-getCurrentUser-008 | userId 空文字 | spec/testcases/identity/getCurrentUser.md#L14 | UserId 生成バリデーションで BusinessRuleError なら PASS |
| TC-getCurrentUser-009 | UserSettingsRepository.find DB 例外 | spec/testcases/identity/getCurrentUser.md#L15 | SystemError なら PASS |
| TC-getCurrentUser-010 | 解除操作の出し分け | spec/testcases/identity/getCurrentUser.md#L16 | 一覧に kind:"email" も出るが解除操作は kind:"sso" にだけ出れば PASS |
| TC-getCurrentUser-011 | email の復号経路 | spec/testcases/identity/getCurrentUser.md#L17 | 認証済み本人の自己参照として1件だけ復号され、一括復号の経路が開かなければ PASS |
| TC-linkSsoCredential-001 | 連携追加の正常系 | spec/testcases/identity/linkSsoCredential.md#L7 | kind:"sso" の要素が加わり version+1、CredentialLocatorStore.record で逆引きが記録され credentialId が返れば PASS |
| TC-linkSsoCredential-002 | 連携後の SSO ログイン | spec/testcases/identity/linkSsoCredential.md#L8 | 逆引きの記録により到達性検査を通ってログインできれば PASS |
| TC-linkSsoCredential-003 | 既存パスワードへの非干渉 | spec/testcases/identity/linkSsoCredential.md#L9 | 既存クレデンシャルの credentialVersion に触れず従来どおりログインできれば PASS |
| TC-linkSsoCredential-004 | sessionEpoch を進めない | spec/testcases/identity/linkSsoCredential.md#L10 | 連携前に確立していた別セッションが失効しなければ PASS |
| TC-linkSsoCredential-005 | 解除対象の生成 | spec/testcases/identity/linkSsoCredential.md#L11 | 連携した SSO が unlinkSsoCredential の正常系として解除できれば PASS（解除対象を作る唯一の経路） |
| TC-linkSsoCredential-006 | メールの一意性に触れない | spec/testcases/identity/linkSsoCredential.md#L12 | IdP 側のメールが何であれ連携が成立し、メールの予約に触れなければ PASS |
| TC-linkSsoCredential-007 | 逆引き未了の中間状態 | spec/testcases/identity/linkSsoCredential.md#L13 | 記録が済むまでその SSO でログインできなければ PASS |
| TC-linkSsoCredential-008 | resume-link の投入 | spec/testcases/identity/linkSsoCredential.md#L14 | 手続きの記録と同じトランザクションで resume-link が投入されれば PASS（前進の唯一の投入点） |
| TC-linkSsoCredential-009 | 他アカウントで使用済みの SSO 主体 | spec/testcases/identity/linkSsoCredential.md#L15 | 予約を獲得できず ConflictError("SSO_IDENTITY_ALREADY_REGISTERED") なら PASS |
| TC-linkSsoCredential-010 | 自アカウントで連携済みの SSO 主体 | spec/testcases/identity/linkSsoCredential.md#L16 | 同じ ConflictError となり冪等な no-op にならなければ PASS |
| TC-linkSsoCredential-011 | 未対応プロバイダ | spec/testcases/identity/linkSsoCredential.md#L17 | BusinessRuleError(UnsupportedSsoProvider) なら PASS |
| TC-linkSsoCredential-012 | providerSubject 形式不正 | spec/testcases/identity/linkSsoCredential.md#L18 | 非空制約の BusinessRuleError なら PASS |
| TC-linkSsoCredential-013 | ユーザー不在 | spec/testcases/identity/linkSsoCredential.md#L19 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-linkSsoCredential-014 | OCC 競合 | spec/testcases/identity/linkSsoCredential.md#L20 | ConflictError("OPTIMISTIC_LOCK_FAILURE") で連携されなければ PASS |
| TC-linkSsoCredential-015 | save DB 例外 | spec/testcases/identity/linkSsoCredential.md#L21 | SystemError でユーザー単位設定側がロールバックされ、別境界の予約は巻き戻らなければ PASS |
| TC-linkSsoCredential-016 | 前進不能時の終端 | spec/testcases/identity/linkSsoCredential.md#L22 | 一様な終端に落ち記録が残り運用へエスカレーションされれば PASS（手順は #45） |
| TC-listAiClientConnections-001 | 一覧の正常系 | spec/testcases/identity/listAiClientConnections.md#L7 | 全接続が connectedAt 降順で返り、各要素に必要フィールドが含まれれば PASS |
| TC-listAiClientConnections-002 | 接続0件 | spec/testcases/identity/listAiClientConnections.md#L8 | 空配列が返れば PASS（エラーにしない） |
| TC-listAiClientConnections-003 | revoked 混在の一覧 | spec/testcases/identity/listAiClientConnections.md#L9 | 失効済み接続も status:"revoked"・revokedAt 非 null で含まれれば PASS |
| TC-listAiClientConnections-004 | 未使用接続の lastUsedAt | spec/testcases/identity/listAiClientConnections.md#L10 | 未使用接続の lastUsedAt が null なら PASS |
| TC-listAiClientConnections-005 | 利用済み接続の lastUsedAt | spec/testcases/identity/listAiClientConnections.md#L11 | recordUsage 済み接続に最終利用日時が入れば PASS |
| TC-listAiClientConnections-006 | テナント分離 | spec/testcases/identity/listAiClientConnections.md#L12 | 自ユーザーの接続のみ返れば PASS |
| TC-listAiClientConnections-007 | listByUserId DB 例外 | spec/testcases/identity/listAiClientConnections.md#L13 | SystemError なら PASS |
| TC-listAiClientConnections-008 | リセット完了による自動失効 | spec/testcases/identity/listAiClientConnections.md#L14 | createdAtResetVersion が前進前の resetVersion と等しい接続だけが revoked になれば PASS |
| TC-listAiClientConnections-009 | 変更を挟んだ自動失効 | spec/testcases/identity/listAiClientConnections.md#L15 | あいだにパスワード変更を挟んでも対象から外れなければ PASS（基準は credentialVersion ではない） |
| TC-listAiClientConnections-010 | パスワード変更では失効しない | spec/testcases/identity/listAiClientConnections.md#L16 | resetVersion が進まないため接続が active のまま残れば PASS |
| TC-loginWithPassword-001 | ログインの正常系 | spec/testcases/identity/loginWithPassword.md#L7 | 正しい資格情報で userId が返れば PASS |
| TC-loginWithPassword-002 | メール正規化後の一致 | spec/testcases/identity/loginWithPassword.md#L8 | 大文字混在・前後空白付きメールでもログイン成功すれば PASS |
| TC-loginWithPassword-003 | 未登録メール | spec/testcases/identity/loginWithPassword.md#L9 | ValidationError("INVALID_CREDENTIALS")。未登録でもダミー材料で同じ計算量を通せば PASS |
| TC-loginWithPassword-004 | パスワード不一致 | spec/testcases/identity/loginWithPassword.md#L10 | ValidationError("INVALID_CREDENTIALS") なら PASS |
| TC-loginWithPassword-005 | SSO 専用アカウントへの試行 | spec/testcases/identity/loginWithPassword.md#L11 | ValidationError("INVALID_CREDENTIALS")（クレデンシャル集合の中身を明かさない）なら PASS |
| TC-loginWithPassword-006 | メール形式不正の変換 | spec/testcases/identity/loginWithPassword.md#L12 | InvalidEmail ではなく ValidationError("INVALID_CREDENTIALS") に変換されれば PASS |
| TC-loginWithPassword-007 | 短いパスワードの変換 | spec/testcases/identity/loginWithPassword.md#L13 | PasswordTooWeak ではなく ValidationError("INVALID_CREDENTIALS") に変換されれば PASS |
| TC-loginWithPassword-008 | 失敗応答の同一性 | spec/testcases/identity/loginWithPassword.md#L14 | 各失敗ケースが同一エラー種別・メッセージで区別不能なら PASS |
| TC-loginWithPassword-009 | 8文字パスワードでの照合 | spec/testcases/identity/loginWithPassword.md#L15 | 最低長パスワードでログイン成功すれば PASS |
| TC-loginWithPassword-010 | CredentialMappingRepository.findByEmail DB 例外 | spec/testcases/identity/loginWithPassword.md#L16 | SystemError なら PASS |
| TC-loginWithPassword-011 | verify 計算失敗 | spec/testcases/identity/loginWithPassword.md#L17 | SystemError（不一致の false と区別）なら PASS |
| TC-loginWithPassword-012 | 到達性検査 | spec/testcases/identity/loginWithPassword.md#L18 | クレデンシャル集合に active な credentialId が無ければ ValidationError("INVALID_CREDENTIALS") になれば PASS |
| TC-loginWithPassword-013 | credentialVersion 不一致 | spec/testcases/identity/loginWithPassword.md#L19 | 照合で拒否され ValidationError("INVALID_CREDENTIALS") なら PASS |
| TC-loginWithPassword-014 | changeState 中間状態 | spec/testcases/identity/loginWithPassword.md#L20 | null でない間はダミー材料が返り旧新どちらも通らなければ PASS |
| TC-loginWithPassword-015 | nextAttemptAllowedAt 未到達 | spec/testcases/identity/loginWithPassword.md#L21 | ダミー経路へ倒れ成功と失敗を区別できなければ PASS |
| TC-loginWithPassword-016 | 照合結果の報告 | spec/testcases/identity/loginWithPassword.md#L22 | 成功で failedAttempts が 0 にリセットされ失敗で前進すれば PASS |
| TC-loginWithPassword-017 | 鍵ローテーション中の両世代並存 | spec/testcases/identity/loginWithPassword.md#L23 | 到達性検査が credentialId だけを見るためログインできれば PASS |
| TC-logout-001 | ログアウトの正常系 | spec/testcases/identity/logout.md#L9 | void 正常終了し、ドメイン状態変更・永続化が一切ないなら PASS |
| TC-logout-002 | セッション破棄は presentation 責務 | spec/testcases/identity/logout.md#L10 | presentation 層がセッションを破棄すれば PASS |
| TC-logout-003 | セッション破棄失敗 | spec/testcases/identity/logout.md#L11 | アダプター層で SystemError として扱われれば PASS |
| TC-registerOrLoginWithSso-001 | 初回 SSO 登録（Google） | spec/testcases/identity/registerOrLoginWithSso.md#L7 | SSO 主体とメールの予約を2本とも獲得してから User が version:0 で作成され userId と isNewUser:true が返れば PASS |
| TC-registerOrLoginWithSso-002 | 初回 SSO 登録（Apple） | spec/testcases/identity/registerOrLoginWithSso.md#L8 | Apple プロバイダでも同様に登録されれば PASS |
| TC-registerOrLoginWithSso-003 | 2回目のログイン | spec/testcases/identity/registerOrLoginWithSso.md#L9 | 既存 userId と isNewUser:false が返り書き込みが発生しなければ PASS |
| TC-registerOrLoginWithSso-004 | IdP メール変更時の主体優先 | spec/testcases/identity/registerOrLoginWithSso.md#L10 | SSO 主体一致が優先されログイン扱いになれば PASS |
| TC-registerOrLoginWithSso-005 | 未対応プロバイダ | spec/testcases/identity/registerOrLoginWithSso.md#L11 | BusinessRuleError(UnsupportedSsoProvider) なら PASS |
| TC-registerOrLoginWithSso-006 | IdP 由来メール形式不正 | spec/testcases/identity/registerOrLoginWithSso.md#L12 | BusinessRuleError(InvalidEmail) なら PASS |
| TC-registerOrLoginWithSso-007 | 既存パスワードアカウントとのメール衝突 | spec/testcases/identity/registerOrLoginWithSso.md#L13 | ConflictError("EMAIL_ALREADY_REGISTERED")・自動リンクなしなら PASS |
| TC-registerOrLoginWithSso-008 | 別プロバイダの SSO アカウントとのメール衝突 | spec/testcases/identity/registerOrLoginWithSso.md#L14 | 認証方式をまたぐメール一意性で ConflictError("EMAIL_ALREADY_REGISTERED") なら PASS |
| TC-registerOrLoginWithSso-009 | 同時初回サインインのレース | spec/testcases/identity/registerOrLoginWithSso.md#L15 | 予約獲得に敗北し ConflictError("SSO_IDENTITY_ALREADY_REGISTERED") なら PASS |
| TC-registerOrLoginWithSso-010 | リポジトリ DB 例外 | spec/testcases/identity/registerOrLoginWithSso.md#L16 | SystemError・ロールバックなら PASS |
| TC-registerOrLoginWithSso-011 | メール予約のみの敗北 | spec/testcases/identity/registerOrLoginWithSso.md#L17 | ConflictError("EMAIL_ALREADY_REGISTERED") となり User も SSO 主体側の予約も確定しなければ PASS |
| TC-registerOrLoginWithSso-012 | 初期化前に中断した中間状態 | spec/testcases/identity/registerOrLoginWithSso.md#L18 | 中間状態のあいだは同じメール / SSO 主体で登録もログインもできず、前進不能の確定時に一様な終端へ落ちれば PASS |
| TC-registerWithPassword-001 | 登録の正常系 | spec/testcases/identity/registerWithPassword.md#L7 | 認証情報側でメールの予約を獲得したうえで User が version:0 で作成され userId が返れば PASS |
| TC-registerWithPassword-002 | メール正規化 | spec/testcases/identity/registerWithPassword.md#L8 | trim・小文字化後のメールで登録されれば PASS |
| TC-registerWithPassword-003 | メール形式不正 | spec/testcases/identity/registerWithPassword.md#L9 | BusinessRuleError(InvalidEmail)・ユーザー非作成なら PASS |
| TC-registerWithPassword-004 | メール321文字 | spec/testcases/identity/registerWithPassword.md#L10 | BusinessRuleError(InvalidEmail) なら PASS |
| TC-registerWithPassword-005 | メール320文字境界 | spec/testcases/identity/registerWithPassword.md#L11 | ちょうど320文字で正常登録されれば PASS |
| TC-registerWithPassword-006 | パスワード7文字 | spec/testcases/identity/registerWithPassword.md#L12 | BusinessRuleError(PasswordTooWeak)・ユーザー非作成なら PASS |
| TC-registerWithPassword-007 | パスワード8文字境界 | spec/testcases/identity/registerWithPassword.md#L13 | 正常登録されれば PASS |
| TC-registerWithPassword-008 | パスワード128文字境界 | spec/testcases/identity/registerWithPassword.md#L14 | 正常登録されれば PASS |
| TC-registerWithPassword-009 | パスワード129文字 | spec/testcases/identity/registerWithPassword.md#L15 | BusinessRuleError(PasswordTooWeak) なら PASS |
| TC-registerWithPassword-010 | パスワード空文字 | spec/testcases/identity/registerWithPassword.md#L16 | BusinessRuleError(PasswordTooWeak) なら PASS |
| TC-registerWithPassword-011 | 同一メールの重複登録 | spec/testcases/identity/registerWithPassword.md#L17 | 事前検証で ConflictError("EMAIL_ALREADY_REGISTERED")・非作成なら PASS |
| TC-registerWithPassword-012 | SSO 登録アカウントとのメール重複 | spec/testcases/identity/registerWithPassword.md#L18 | ConflictError("EMAIL_ALREADY_REGISTERED")・自動リンクなしなら PASS |
| TC-registerWithPassword-013 | 正規化後一致の重複検出 | spec/testcases/identity/registerWithPassword.md#L19 | 大文字/小文字表記違いでも重複検出されれば PASS |
| TC-registerWithPassword-014 | 同時登録レース | spec/testcases/identity/registerWithPassword.md#L20 | 予約獲得に敗北し ConflictError("EMAIL_ALREADY_REGISTERED") なら PASS |
| TC-registerWithPassword-015 | hash 失敗 | spec/testcases/identity/registerWithPassword.md#L21 | SystemError・ユーザー非作成なら PASS |
| TC-registerWithPassword-016 | UserSettingsRepository.insert DB 例外 | spec/testcases/identity/registerWithPassword.md#L22 | SystemError でユーザー単位設定側がロールバックされ、別境界の予約は巻き戻らず「そのメールで登録もログインもできない」だけが観測されれば PASS |
| TC-requestPasswordReset-001 | 依頼の正常系（送る側） | spec/testcases/identity/requestPasswordReset.md#L9 | 同じ transactionSync で窓行が1行・イベント行がちょうど1行書かれ、トークンが発行され sweep-reset-tokens が投入され、配送後に sendPasswordResetMail(to, resetToken, providerIdempotencyKey) が呼ばれて void 正常終了なら PASS |
| TC-requestPasswordReset-002 | 未登録メールの送らない側 | spec/testcases/identity/requestPasswordReset.md#L10 | 窓行・イベント行・ジョブの投入・起床・応答が登録済みの場合と一致し、tokenId に不透明値が入って行の形が一字も違わず、送信材料 RPC が nothing-to-send を返せば PASS |
| TC-requestPasswordReset-003 | SSO 専用アカウントの送らない側 | spec/testcases/identity/requestPasswordReset.md#L11 | 判定が passwordVerifier の有無で行われ、窓行・イベント行・投入・起床・応答が他ケースと一致すれば PASS |
| TC-requestPasswordReset-004 | 4ケースの応答と処理経路の同一性 | spec/testcases/identity/requestPasswordReset.md#L12 | 同じ窓の状態に対して4ケースが一様（最初の依頼なら必ずちょうど1行、発行済みの窓なら1行も書かない）で、応答も区別不能で、差が無いことの主張が測定対象4つに限定され（総書き込み行数と実測処理時間では測らない）応答が配送の完了を待たないことが根拠として書かれていれば PASS |
| TC-requestPasswordReset-005 | メール形式不正 | spec/testcases/identity/requestPasswordReset.md#L13 | BusinessRuleError(InvalidEmail) なら PASS |
| TC-requestPasswordReset-006 | 正規化後一致での送る側 | spec/testcases/identity/requestPasswordReset.md#L14 | 大文字混在メールでも正規化後の一致で送る側になり、windowKey が canonical 由来なので同じ窓に落ちれば PASS |
| TC-requestPasswordReset-007 | トークン発行障害 | spec/testcases/identity/requestPasswordReset.md#L15 | SystemError なら PASS |
| TC-requestPasswordReset-008 | 配送側の送信基盤障害 | spec/testcases/identity/requestPasswordReset.md#L16 | 送信基盤の失敗が依頼の応答に一切現れず、Queue の retry → DLQ で扱われれば PASS |
| TC-requestPasswordReset-009 | CredentialMappingRepository.findByEmail DB 例外 | spec/testcases/identity/requestPasswordReset.md#L17 | SystemError なら PASS |
| TC-requestPasswordReset-010 | 連打時の窓による発行判断 | spec/testcases/identity/requestPasswordReset.md#L18 | 2回目以降は claimWindow が false を返してイベント行もトークンも書かれず、書き込みと起床が窓の数に比例すれば PASS |
| TC-requestPasswordReset-011 | スロットル中の依頼 | spec/testcases/identity/requestPasswordReset.md#L19 | 応答・起床の有無・sweep-reset-tokens の投入・窓行が1行のままであることの4つが一致し、差がイベント行0行とトークン非発行の2つに限られ、比較先が同じ窓の状態（発行済みの窓）に置いた他の3ケースであれば PASS（この4つは TC-requestPasswordReset-016 の測定対象4つとは別の集合） |
| TC-requestPasswordReset-012 | イベント行の payload の中身 | spec/testcases/identity/requestPasswordReset.md#L20 | 載るのが tokenId / メール種別の2つだけで、メールアドレス・生トークン・userId も発行元 bucket の routing key も載らなければ PASS（routing key は relay が publish 時に Queue メッセージへ押す項目） |
| TC-requestPasswordReset-013 | 未使用トークンの置き換え | spec/testcases/identity/requestPasswordReset.md#L21 | 新しい窓での最初の依頼だけがそのクレデンシャル宛の未使用トークンをすべて置き換えれば PASS |
| TC-requestPasswordReset-014 | 同一窓への連打で届くのは1通 | spec/testcases/identity/requestPasswordReset.md#L22 | 有効なリンクを含むメールが1通だけ届き（0通でも2通でもない）、1通目のリンクが2回目の依頼後も有効なら PASS |
| TC-requestPasswordReset-015 | 順序逆転した新旧2件の配送 | spec/testcases/identity/requestPasswordReset.md#L23 | 新しいほうが send で送信され、古いほうが nothing-to-send を返して no-op になれば PASS（理由は期待値に書けない） |
| TC-requestPasswordReset-016 | 未登録アドレスでの4測定対象の一致 | spec/testcases/identity/requestPasswordReset.md#L24 | outbox_events の行数・reset_request_windows の行数・Alarm 起床の有無・sweep-reset-tokens 投入の有無の4つが登録済みの場合と一致すれば PASS（総書き込み行数では測らない） |
| TC-requestPasswordReset-017 | 窓ストア障害 | spec/testcases/identity/requestPasswordReset.md#L25 | claimWindow のストア障害が SystemError になり、宛先の実在性に起因する失敗は応答に反映されなければ PASS |
| TC-requestPasswordReset-018 | イベント行の aggregate_id | spec/testcases/identity/requestPasswordReset.md#L26 | windowKey が入り credentialId が入らなければ PASS（4ケースで同じ導出で決まる） |
| TC-requestPasswordReset-019 | sweep-reset-tokens のトークン行と窓行の同時削除 | spec/testcases/identity/requestPasswordReset.md#L27 | 期限切れの password_reset_tokens の行と reset_request_windows の窓行が同じ起床で削除されれば PASS（kind は増えない） |
| TC-requestPasswordReset-020 | 期限内の窓行の残存 | spec/testcases/identity/requestPasswordReset.md#L28 | expires_at を過ぎた窓行だけが削除され、期限内の窓行が残って claimWindow の判定に効けば PASS |
| TC-requestPasswordReset-021 | 未登録アドレスだけの bucket での窓行の掃除 | spec/testcases/identity/requestPasswordReset.md#L29 | トークン行が1行も無い bucket でもジョブが投入され期限切れの窓行が削除され、reset_request_windows が単調増加しなければ PASS |
| TC-revokeAiClientConnection-001 | 失効の正常系 | spec/testcases/identity/revokeAiClientConnection.md#L7 | revoked へ遷移・version+1 で void 正常終了なら PASS |
| TC-revokeAiClientConnection-003 | 接続不在 | spec/testcases/identity/revokeAiClientConnection.md#L8 | NotFoundError("CONNECTION_NOT_FOUND") なら PASS |
| TC-revokeAiClientConnection-004 | 他ユーザー接続の指定 | spec/testcases/identity/revokeAiClientConnection.md#L9 | 自 DO の中だけを引くため null が返り、不在と区別しない NotFoundError で相手の接続が不変なら PASS |
| TC-revokeAiClientConnection-005 | connectionId 空文字 | spec/testcases/identity/revokeAiClientConnection.md#L10 | ID 生成バリデーションで BusinessRuleError なら PASS |
| TC-revokeAiClientConnection-006 | 再失効の冪等性 | spec/testcases/identity/revokeAiClientConnection.md#L11 | 変更も version 進行も revokedAt の変化もなく正常終了すれば PASS |
| TC-revokeAiClientConnection-007 | 同時失効の OCC 競合 | spec/testcases/identity/revokeAiClientConnection.md#L12 | 先勝ち成功・後発 ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-revokeAiClientConnection-008 | 失効の不可逆性 | spec/testcases/identity/revokeAiClientConnection.md#L13 | 再有効化不可で新しい認可フローが必要なことが確認できれば PASS |
| TC-revokeAiClientConnection-009 | save DB 例外 | spec/testcases/identity/revokeAiClientConnection.md#L14 | SystemError・ロールバック・接続 active のままなら PASS |
| TC-revokeAiClientConnection-010 | 失効後の DO 内ガード | spec/testcases/identity/revokeAiClientConnection.md#L15 | 次のリクエストで DO 内ガードが status を直読みして拒否すれば PASS（失効の伝播経路を持たない） |
| TC-revokeAllAiClientConnections-001 | 一括失効の正常系 | spec/testcases/identity/revokeAllAiClientConnections.md#L7 | active 3件がすべて revoked になり revokedCount:3 / failedCount:0 が返れば PASS |
| TC-revokeAllAiClientConnections-002 | リセット完了画面からの一括失効 | spec/testcases/identity/revokeAllAiClientConnections.md#L8 | 自動失効の射程外だった古い接続も含め active な全件が revoked になれば PASS |
| TC-revokeAllAiClientConnections-003 | revoked 混在時の冪等性 | spec/testcases/identity/revokeAllAiClientConnections.md#L9 | 既に revoked の接続を no-op として数えず revokedCount が active 件数だけになれば PASS |
| TC-revokeAllAiClientConnections-004 | 接続0件 | spec/testcases/identity/revokeAllAiClientConnections.md#L10 | revokedCount:0 / failedCount:0 が返りエラーにならなければ PASS |
| TC-revokeAllAiClientConnections-005 | 個別 OCC 競合での部分失敗 | spec/testcases/identity/revokeAllAiClientConnections.md#L11 | 競合した1件を記録して続行し、残りが失効して failedCount:1 が返れば PASS |
| TC-revokeAllAiClientConnections-006 | 部分失敗後の再実行 | spec/testcases/identity/revokeAllAiClientConnections.md#L12 | 失効済みが対象に現れず残件だけが消化されれば PASS |
| TC-revokeAllAiClientConnections-007 | listByUserId DB 例外 | spec/testcases/identity/revokeAllAiClientConnections.md#L13 | SystemError となり1件も失効しなければ PASS |
| TC-revokeAllAiClientConnections-008 | userId 形式不正 | spec/testcases/identity/revokeAllAiClientConnections.md#L14 | UserId.create の BusinessRuleError となり接続が失効しなければ PASS |
| TC-unlinkSsoCredential-001 | SSO 解除の正常系 | spec/testcases/identity/unlinkSsoCredential.md#L7 | 要素の除去・save・deleteByCredentialId・advanceSessionEpoch と認証情報側の写像行/リセットトークン行の消去が行われれば PASS |
| TC-unlinkSsoCredential-002 | 解除後の SSO ログイン | spec/testcases/identity/unlinkSsoCredential.md#L8 | 解除した SSO 主体でログインできなければ PASS |
| TC-unlinkSsoCredential-003 | sessionEpoch の前進 | spec/testcases/identity/unlinkSsoCredential.md#L9 | 解除前に確立していた別セッションが次のリクエストで失効すれば PASS |
| TC-unlinkSsoCredential-004 | 中間状態での SSO ログイン | spec/testcases/identity/unlinkSsoCredential.md#L10 | 認証情報側が未了でも逆引きが先に消えているためログインできなければ PASS（壊れる向きが片方向） |
| TC-unlinkSsoCredential-005 | deleteMapping の冪等性 | spec/testcases/identity/unlinkSsoCredential.md#L11 | 再実行が「無ければ成功」として正常終了すれば PASS |
| TC-unlinkSsoCredential-006 | ログイン手段が残る解除 | spec/testcases/identity/unlinkSsoCredential.md#L12 | SSO 2件のうち片方の解除が成功すれば PASS |
| TC-unlinkSsoCredential-007 | kind:"email" の解除拒否 | spec/testcases/identity/unlinkSsoCredential.md#L13 | BusinessRuleError で拒否されれば PASS（メールクレデンシャルの解除経路は存在しない） |
| TC-unlinkSsoCredential-008 | 最後のログイン手段の解除拒否 | spec/testcases/identity/unlinkSsoCredential.md#L14 | BusinessRuleError(LastCredentialRemoval) となり、usableForLogin が偽のメール要素を数に入れなければ PASS |
| TC-unlinkSsoCredential-009 | クレデンシャル不在 | spec/testcases/identity/unlinkSsoCredential.md#L15 | NotFoundError("CREDENTIAL_NOT_FOUND") なら PASS |
| TC-unlinkSsoCredential-010 | ユーザー不在 | spec/testcases/identity/unlinkSsoCredential.md#L16 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-unlinkSsoCredential-011 | OCC 競合 | spec/testcases/identity/unlinkSsoCredential.md#L17 | ConflictError("OPTIMISTIC_LOCK_FAILURE") で解除されなければ PASS |
| TC-unlinkSsoCredential-012 | credentialId 形式不正 | spec/testcases/identity/unlinkSsoCredential.md#L18 | CredentialId.create の BusinessRuleError なら PASS |
| TC-unlinkSsoCredential-013 | save DB 例外 | spec/testcases/identity/unlinkSsoCredential.md#L19 | SystemError・ロールバックで逆引きも写像も消えなければ PASS |
| TC-unlinkSsoCredential-014 | 前進不能時の終端 | spec/testcases/identity/unlinkSsoCredential.md#L20 | 一様な終端に落ち記録が残り運用へエスカレーションされれば PASS（手順は #45） |
| TC-unlinkSsoCredential-015 | sweep-orphan-mapping の投入 | spec/testcases/identity/unlinkSsoCredential.md#L21 | 逆引きを消す前に写像材料が全世代分退避され、同じトランザクションで sweep-orphan-mapping が投入されれば PASS（唯一の投入点） |
| TC-createDocument-001 | 作成の正常系 | spec/testcases/knowledge/createDocument.md#L7 | ActiveDocument・リビジョン#1・SourceLink 2件が同一 UoW で保存され、同じ transactionSync で当該ドキュメントと出典メモ 2 件のエントリが projection に反映されれば PASS |
| TC-createDocument-002 | 出典なし作成 | spec/testcases/knowledge/createDocument.md#L8 | sourceMemoIds:[] で SourceLink 0件のまま正常作成されれば PASS |
| TC-createDocument-003 | changeReason 省略時の既定値 | spec/testcases/knowledge/createDocument.md#L9 | 「作成」が補完されリビジョン#1 の changeReason になれば PASS |
| TC-createDocument-004 | changeReason 空白のみ | spec/testcases/knowledge/createDocument.md#L10 | trim 後空でも「作成」が補完され正常作成されれば PASS |
| TC-createDocument-005 | 出典 ID の重複除去 | spec/testcases/knowledge/createDocument.md#L11 | 重複 ID が除去され SourceLink 1件のみになれば PASS |
| TC-createDocument-006 | archived トピック配下への作成 | spec/testcases/knowledge/createDocument.md#L12 | archived トピック配下でも正常に作成されれば PASS |
| TC-createDocument-007 | 空本文での作成 | spec/testcases/knowledge/createDocument.md#L13 | body:"" で正常作成されれば PASS |
| TC-createDocument-008 | 本文 1,000,000 文字境界 | spec/testcases/knowledge/createDocument.md#L14 | 上限ちょうどで正常作成されれば PASS |
| TC-createDocument-009 | 本文 1,000,001 文字 | spec/testcases/knowledge/createDocument.md#L15 | BusinessRuleError(DocumentBodyTooLong)・非作成なら PASS |
| TC-createDocument-010 | タイトル不正各種 | spec/testcases/knowledge/createDocument.md#L16 | 空/空白のみ/改行入り/201文字がそれぞれ対応する BusinessRuleError になれば PASS |
| TC-createDocument-011 | タイトル200文字境界 | spec/testcases/knowledge/createDocument.md#L17 | ちょうど200文字で正常作成されれば PASS |
| TC-createDocument-012 | changeReason 不正 | spec/testcases/knowledge/createDocument.md#L18 | 改行入り/201文字が ChangeReasonMultiline/ChangeReasonTooLong になれば PASS |
| TC-createDocument-013 | changeReason 200文字境界 | spec/testcases/knowledge/createDocument.md#L19 | ちょうど200文字で正常作成されれば PASS |
| TC-createDocument-014 | トピック不在 | spec/testcases/knowledge/createDocument.md#L20 | NotFoundError・非作成なら PASS |
| TC-createDocument-015 | ゴミ箱内トピックへの作成 | spec/testcases/knowledge/createDocument.md#L21 | NotFoundError になれば PASS（ゴミ箱内トピック配下に作らせない） |
| TC-createDocument-016 | 他ユーザートピックへの作成 | spec/testcases/knowledge/createDocument.md#L22 | 到達可能性により NotFoundError なら PASS |
| TC-createDocument-017 | 出典の一部不在で全体失敗 | spec/testcases/knowledge/createDocument.md#L23 | NotFoundError で全体失敗しドキュメント・リビジョン・リンクとも非作成なら PASS |
| TC-createDocument-018 | 出典の一部がゴミ箱内 | spec/testcases/knowledge/createDocument.md#L24 | listActiveByIds に含まれず NotFoundError で全体失敗すれば PASS |
| TC-createDocument-019 | 出典の一部が他ユーザー所有 | spec/testcases/knowledge/createDocument.md#L25 | 区別なしの NotFoundError で全体失敗すれば PASS |
| TC-createDocument-020 | 出典 ID に空文字 | spec/testcases/knowledge/createDocument.md#L26 | MemoId 構築違反で BusinessRuleError なら PASS |
| TC-createDocument-021 | トピック touch と trashTopic の競合 | spec/testcases/knowledge/createDocument.md#L27 | touch が 0 行更新で ConflictError となり trashed トピック配下に active ドキュメントが生まれなければ PASS |
| TC-createDocument-022 | トピック touch と updateTopic の競合 | spec/testcases/knowledge/createDocument.md#L28 | 同様に ConflictError となり非作成なら PASS |
| TC-createDocument-023 | touch の副作用範囲 | spec/testcases/knowledge/createDocument.md#L29 | トピックの version のみ進み内容不変なら PASS（touch は内容変更ではない） |
| TC-createDocument-024 | AI 経由の作成 | spec/testcases/knowledge/createDocument.md#L30 | MCP create_document が人間 UI と同一の振る舞いになれば PASS |
| TC-createDocument-025 | insertSourceLinks DB 例外 | spec/testcases/knowledge/createDocument.md#L31 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-createTopic-001 | 作成の正常系 | spec/testcases/knowledge/createTopic.md#L7 | active/version:0 のトピックとビューが返り、トピックはエントリを持たないため projection が更新されなければ PASS |
| TC-createTopic-002 | description 省略 | spec/testcases/knowledge/createTopic.md#L8 | description:null で正常作成されれば PASS |
| TC-createTopic-003 | name の前後空白 | spec/testcases/knowledge/createTopic.md#L9 | trim 後非空として正常作成されれば PASS |
| TC-createTopic-004 | name 空文字 | spec/testcases/knowledge/createTopic.md#L10 | BusinessRuleError(EmptyTopicName)・非作成なら PASS |
| TC-createTopic-005 | name 空白のみ | spec/testcases/knowledge/createTopic.md#L11 | BusinessRuleError(EmptyTopicName) なら PASS |
| TC-createTopic-006 | name 改行入り | spec/testcases/knowledge/createTopic.md#L12 | BusinessRuleError(TopicNameMultiline) なら PASS |
| TC-createTopic-007 | name 100文字境界 | spec/testcases/knowledge/createTopic.md#L13 | ちょうど100文字で正常作成されれば PASS |
| TC-createTopic-008 | name 101文字 | spec/testcases/knowledge/createTopic.md#L14 | BusinessRuleError(TopicNameTooLong) なら PASS |
| TC-createTopic-009 | description 空文字 | spec/testcases/knowledge/createTopic.md#L15 | BusinessRuleError(EmptyTopicDescription) なら PASS（説明なしは null で表す） |
| TC-createTopic-010 | description 500文字境界 | spec/testcases/knowledge/createTopic.md#L16 | ちょうど500文字で正常作成されれば PASS |
| TC-createTopic-011 | description 501文字 | spec/testcases/knowledge/createTopic.md#L17 | BusinessRuleError(TopicDescriptionTooLong) なら PASS |
| TC-createTopic-012 | 同名トピックの許容 | spec/testcases/knowledge/createTopic.md#L18 | 名前の一意制約なしで正常作成されれば PASS |
| TC-createTopic-013 | AI 経由の作成 | spec/testcases/knowledge/createTopic.md#L19 | MCP create_topic が人間 UI と同一の振る舞いになれば PASS |
| TC-createTopic-014 | insert DB 例外 | spec/testcases/knowledge/createTopic.md#L20 | SystemError(DatabaseError)・ロールバックでトピックが作成されなければ PASS |
| TC-diffDocumentRevisions-001 | 二点取得の正常系 | spec/testcases/knowledge/diffDocumentRevisions.md#L7 | base/target に当時の全文スナップショットとメタデータが返り差分計算はされなければ PASS |
| TC-diffDocumentRevisions-002 | 新→旧の順指定 | spec/testcases/knowledge/diffDocumentRevisions.md#L8 | 順序制約なく指定どおり返れば PASS |
| TC-diffDocumentRevisions-003 | 隣接二点・最小構成 | spec/testcases/knowledge/diffDocumentRevisions.md#L9 | リビジョン番号 1 を含む二点が正常に返れば PASS |
| TC-diffDocumentRevisions-004 | ゴミ箱内ドキュメントの二点取得 | spec/testcases/knowledge/diffDocumentRevisions.md#L10 | リビジョンが引ければ返る（人間 UI の履歴閲覧経路）なら PASS |
| TC-diffDocumentRevisions-005 | 同一番号の二点指定 | spec/testcases/knowledge/diffDocumentRevisions.md#L11 | ValidationError なら PASS |
| TC-diffDocumentRevisions-006 | 存在しないリビジョン番号 | spec/testcases/knowledge/diffDocumentRevisions.md#L12 | 一方でも不在なら NotFoundError で PASS |
| TC-diffDocumentRevisions-007 | ドキュメント不在 | spec/testcases/knowledge/diffDocumentRevisions.md#L13 | NotFoundError なら PASS |
| TC-diffDocumentRevisions-008 | 他ユーザー所有 | spec/testcases/knowledge/diffDocumentRevisions.md#L14 | 到達可能性により NotFoundError なら PASS |
| TC-diffDocumentRevisions-009 | revisionNumber 0 | spec/testcases/knowledge/diffDocumentRevisions.md#L15 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffDocumentRevisions-010 | revisionNumber 非整数 | spec/testcases/knowledge/diffDocumentRevisions.md#L16 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffDocumentRevisions-011 | documentId 空文字 | spec/testcases/knowledge/diffDocumentRevisions.md#L17 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-diffDocumentRevisions-012 | findRevision DB 例外 | spec/testcases/knowledge/diffDocumentRevisions.md#L18 | SystemError(DatabaseError) なら PASS |
| TC-editDocument-001 | 編集保存の正常系 | spec/testcases/knowledge/editDocument.md#L7 | result:"saved"・新リビジョン（人間 actor・指定理由）・version+1 で、同じ transactionSync でエントリが作り直されれば PASS |
| TC-editDocument-002 | changeReason 省略時の既定値 | spec/testcases/knowledge/editDocument.md#L8 | 「手動編集」が補完されれば PASS |
| TC-editDocument-003 | changeReason 空白のみ | spec/testcases/knowledge/editDocument.md#L9 | 「手動編集」補完で result:"saved" なら PASS |
| TC-editDocument-004 | 同一内容の保存 | spec/testcases/knowledge/editDocument.md#L10 | result:"unchanged" でリビジョン・save・エントリの作り直しがなければ PASS |
| TC-editDocument-005 | タイトルのみ変更 | spec/testcases/knowledge/editDocument.md#L11 | 差分ありとして新リビジョンが積まれれば PASS |
| TC-editDocument-006 | 編集競合の conflict 応答 | spec/testcases/knowledge/editDocument.md#L12 | エラーではなく result:"conflict" で現在値・currentVersion・latestRevision メタが返り何も書き込まれなければ PASS |
| TC-editDocument-007 | conflict 後の「そのまま保存」 | spec/testcases/knowledge/editDocument.md#L13 | currentVersion で再保存すると saved になり介在編集も履歴に残れば PASS |
| TC-editDocument-008 | タイトル空文字 | spec/testcases/knowledge/editDocument.md#L14 | BusinessRuleError(EmptyDocumentTitle)・リビジョン非追加なら PASS |
| TC-editDocument-009 | タイトル改行/201文字 | spec/testcases/knowledge/editDocument.md#L15 | DocumentTitleMultiline/DocumentTitleTooLong になれば PASS |
| TC-editDocument-010 | タイトル200文字境界 | spec/testcases/knowledge/editDocument.md#L16 | 正常保存されれば PASS |
| TC-editDocument-011 | 空本文への保存 | spec/testcases/knowledge/editDocument.md#L17 | body:"" で正常保存されれば PASS |
| TC-editDocument-012 | 本文上限境界 | spec/testcases/knowledge/editDocument.md#L18 | 1,000,000 文字は正常・1,000,001 文字は DocumentBodyTooLong なら PASS |
| TC-editDocument-013 | changeReason 不正 | spec/testcases/knowledge/editDocument.md#L19 | 改行入り/201文字が対応する BusinessRuleError になれば PASS |
| TC-editDocument-014 | ドキュメント不在 | spec/testcases/knowledge/editDocument.md#L20 | NotFoundError なら PASS |
| TC-editDocument-015 | ゴミ箱内ドキュメントの編集 | spec/testcases/knowledge/editDocument.md#L21 | findById が active のみ返し NotFoundError なら PASS |
| TC-editDocument-016 | 他ユーザー所有 | spec/testcases/knowledge/editDocument.md#L22 | 到達可能性により NotFoundError なら PASS |
| TC-editDocument-017 | documentId 空文字 | spec/testcases/knowledge/editDocument.md#L23 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-editDocument-018 | save 直前の割り込み競合 | spec/testcases/knowledge/editDocument.md#L24 | 0 行更新または一意制約違反で ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-editDocument-019 | insertRevision DB 例外 | spec/testcases/knowledge/editDocument.md#L25 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-editDocumentByAi-001 | patch 適用の正常系 | spec/testcases/knowledge/editDocumentByAi.md#L7 | 置換後本文で changed:true・AI actor の新リビジョンが記録され、同じ transactionSync でエントリが作り直されれば PASS |
| TC-editDocumentByAi-002 | mode 省略時の既定 | spec/testcases/knowledge/editDocumentByAi.md#L8 | 既定モード patch として適用されれば PASS |
| TC-editDocumentByAi-003 | hunks の逐次適用 | spec/testcases/knowledge/editDocumentByAi.md#L9 | 配列順に前の置換結果へ順次マッチして適用されれば PASS |
| TC-editDocumentByAi-004 | newText 空文字による削除 | spec/testcases/knowledge/editDocumentByAi.md#L10 | 該当箇所の削除として適用されれば PASS |
| TC-editDocumentByAi-005 | replaceAll の正常系 | spec/testcases/knowledge/editDocumentByAi.md#L11 | 受領全文で新リビジョンが積まれタイトルは維持されれば PASS |
| TC-editDocumentByAi-006 | 空本文への replaceAll | spec/testcases/knowledge/editDocumentByAi.md#L12 | 空本文ドキュメントが replaceAll で正常編集されれば PASS |
| TC-editDocumentByAi-007 | 空本文への patch | spec/testcases/knowledge/editDocumentByAi.md#L13 | BusinessRuleError(PatchTargetNotFound) なら PASS |
| TC-editDocumentByAi-008 | replaceAll で空本文へ | spec/testcases/knowledge/editDocumentByAi.md#L14 | body:"" への置換が正常受理され新リビジョンが積まれれば PASS |
| TC-editDocumentByAi-009 | 同一結果の編集 | spec/testcases/knowledge/editDocumentByAi.md#L15 | changed:false でリビジョン・エントリの作り直しがなければ PASS |
| TC-editDocumentByAi-010 | changeReason 省略の拒否 | spec/testcases/knowledge/editDocumentByAi.md#L16 | ValidationError で既定値補完されなければ PASS（AI は変更理由必須） |
| TC-editDocumentByAi-011 | changeReason 空白のみの拒否 | spec/testcases/knowledge/editDocumentByAi.md#L17 | ValidationError なら PASS |
| TC-editDocumentByAi-012 | パッチ 0 一致 | spec/testcases/knowledge/editDocumentByAi.md#L18 | BusinessRuleError(PatchTargetNotFound)・ドキュメント不変なら PASS |
| TC-editDocumentByAi-013 | パッチ複数一致 | spec/testcases/knowledge/editDocumentByAi.md#L19 | BusinessRuleError(PatchTargetAmbiguous)・ドキュメント不変なら PASS |
| TC-editDocumentByAi-014 | 部分適用の禁止 | spec/testcases/knowledge/editDocumentByAi.md#L20 | 一部 hunk 不一致でパッチ全体が失敗し 1 件目の置換も反映されなければ PASS |
| TC-editDocumentByAi-015 | patches 空配列 | spec/testcases/knowledge/editDocumentByAi.md#L21 | BusinessRuleError(EmptyPatch) なら PASS |
| TC-editDocumentByAi-016 | oldText 空文字 | spec/testcases/knowledge/editDocumentByAi.md#L22 | BusinessRuleError(EmptyPatchOldText) なら PASS |
| TC-editDocumentByAi-017 | パッチ適用結果の本文超過 | spec/testcases/knowledge/editDocumentByAi.md#L23 | 適用結果の構築で BusinessRuleError(DocumentBodyTooLong) なら PASS |
| TC-editDocumentByAi-018 | replaceAll の本文超過 | spec/testcases/knowledge/editDocumentByAi.md#L24 | BusinessRuleError(DocumentBodyTooLong) なら PASS |
| TC-editDocumentByAi-019 | changeReason 不正 | spec/testcases/knowledge/editDocumentByAi.md#L25 | 改行入り/201文字が対応する BusinessRuleError になれば PASS |
| TC-editDocumentByAi-020 | changeReason 200文字境界 | spec/testcases/knowledge/editDocumentByAi.md#L26 | 正常編集されれば PASS |
| TC-editDocumentByAi-021 | ドキュメント不在 | spec/testcases/knowledge/editDocumentByAi.md#L27 | NotFoundError なら PASS |
| TC-editDocumentByAi-022 | ゴミ箱内は存在しない扱い | spec/testcases/knowledge/editDocumentByAi.md#L28 | NotFoundError で存在事実も漏らさなければ PASS |
| TC-editDocumentByAi-023 | 他ユーザー所有 | spec/testcases/knowledge/editDocumentByAi.md#L29 | 到達可能性により NotFoundError なら PASS |
| TC-editDocumentByAi-024 | documentId 空文字 | spec/testcases/knowledge/editDocumentByAi.md#L30 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-editDocumentByAi-025 | 人間編集との競合 | spec/testcases/knowledge/editDocumentByAi.md#L31 | 0 行更新または一意制約違反で ConflictError なら PASS |
| TC-editDocumentByAi-026 | save DB 例外 | spec/testcases/knowledge/editDocumentByAi.md#L32 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-getDocument-001 | 取得の正常系 | spec/testcases/knowledge/getDocument.md#L7 | id/topicId/title/body/latestRevision/version/日時が返れば PASS |
| TC-getDocument-002 | 空本文の取得 | spec/testcases/knowledge/getDocument.md#L8 | body:"" で正常に返れば PASS |
| TC-getDocument-003 | 出典一覧の非包含 | spec/testcases/knowledge/getDocument.md#L9 | 出典メモ一覧が含まれなければ PASS（listDocumentSourceMemos の責務） |
| TC-getDocument-004 | ドキュメント不在 | spec/testcases/knowledge/getDocument.md#L10 | NotFoundError なら PASS |
| TC-getDocument-005 | ゴミ箱内の非取得 | spec/testcases/knowledge/getDocument.md#L11 | findById が active のみ返し NotFoundError なら PASS |
| TC-getDocument-006 | 他ユーザー所有 | spec/testcases/knowledge/getDocument.md#L12 | 到達可能性により NotFoundError（存在の有無も漏らさない）なら PASS |
| TC-getDocument-007 | documentId 空文字 | spec/testcases/knowledge/getDocument.md#L13 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-getDocument-008 | AI 経由の取得 | spec/testcases/knowledge/getDocument.md#L14 | MCP get(type:"document") が人間 UI と同一結果になれば PASS |
| TC-getDocument-009 | findById DB 例外 | spec/testcases/knowledge/getDocument.md#L15 | SystemError(DatabaseError) なら PASS |
| TC-getTopic-001 | 詳細取得の正常系 | spec/testcases/knowledge/getTopic.md#L7 | topic・documents・relatedMemos（出典リンク集約）が返れば PASS |
| TC-getTopic-002 | archived トピックの取得 | spec/testcases/knowledge/getTopic.md#L8 | status:"archived" として正常に返れば PASS |
| TC-getTopic-003 | 配下 0 件 | spec/testcases/knowledge/getTopic.md#L9 | documents:[]・relatedMemos:[] で返れば PASS |
| TC-getTopic-004 | 出典リンク 0 件 | spec/testcases/knowledge/getTopic.md#L10 | relatedMemos:[] で返れば PASS |
| TC-getTopic-005 | relatedMemos の重複除去 | spec/testcases/knowledge/getTopic.md#L11 | 同一メモが 1 件だけ現れれば PASS |
| TC-getTopic-006 | ソフトデリート済み出典の表示 | spec/testcases/knowledge/getTopic.md#L12 | deleted:true の RelatedMemoView として返れば PASS |
| TC-getTopic-007 | ハードデリート済み出典の非表示 | spec/testcases/knowledge/getTopic.md#L13 | relatedMemos に一切現れなければ PASS（ADR-003） |
| TC-getTopic-008 | 一括取得（N+1 回避） | spec/testcases/knowledge/getTopic.md#L14 | 出典リンク・メモ本文が各 1 クエリで取得されれば PASS |
| TC-getTopic-009 | 配下のゴミ箱内ドキュメント除外 | spec/testcases/knowledge/getTopic.md#L15 | documents に active のみ含まれれば PASS |
| TC-getTopic-010 | トピック不在 | spec/testcases/knowledge/getTopic.md#L16 | NotFoundError なら PASS |
| TC-getTopic-011 | ゴミ箱内トピック | spec/testcases/knowledge/getTopic.md#L17 | NotFoundError なら PASS（詳細は trash ドメインの責務） |
| TC-getTopic-012 | 他ユーザー所有 | spec/testcases/knowledge/getTopic.md#L18 | 到達可能性により NotFoundError なら PASS |
| TC-getTopic-013 | topicId 空文字 | spec/testcases/knowledge/getTopic.md#L19 | BusinessRuleError(InvalidTopicId) なら PASS |
| TC-getTopic-014 | メモ一括取得 DB 例外 | spec/testcases/knowledge/getTopic.md#L20 | SystemError(DatabaseError) なら PASS |
| TC-listDocumentRevisions-001 | 履歴一覧の正常系 | spec/testcases/knowledge/listDocumentRevisions.md#L7 | revisionNumber 昇順のメタデータのみ（全文なし）と latestRevision が返れば PASS |
| TC-listDocumentRevisions-002 | AI 編集リビジョンの actor | spec/testcases/knowledge/listDocumentRevisions.md#L8 | actor が { kind:"aiClient", clientName } で返れば PASS |
| TC-listDocumentRevisions-003 | 初版のみの履歴 | spec/testcases/knowledge/listDocumentRevisions.md#L9 | 1 件のみ返れば PASS（存在すれば必ず 1 件以上） |
| TC-listDocumentRevisions-004 | ゴミ箱内ドキュメントの履歴 | spec/testcases/knowledge/listDocumentRevisions.md#L10 | findByIdIncludingTrashed で正常に履歴が返れば PASS |
| TC-listDocumentRevisions-005 | ドキュメント不在 | spec/testcases/knowledge/listDocumentRevisions.md#L11 | NotFoundError なら PASS（ハードデリートは履歴ごと消える） |
| TC-listDocumentRevisions-006 | 他ユーザー所有 | spec/testcases/knowledge/listDocumentRevisions.md#L12 | 到達可能性により NotFoundError なら PASS |
| TC-listDocumentRevisions-007 | documentId 空文字 | spec/testcases/knowledge/listDocumentRevisions.md#L13 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-listDocumentRevisions-008 | listRevisions DB 例外 | spec/testcases/knowledge/listDocumentRevisions.md#L14 | SystemError(DatabaseError) なら PASS |
| TC-listDocumentSourceMemos-001 | 出典一覧の正常系 | spec/testcases/knowledge/listDocumentSourceMemos.md#L7 | memoId/snippet/postedAt/deleted:false/linkedAt を持つ 2 件が返れば PASS |
| TC-listDocumentSourceMemos-002 | 編集後メモの snippet | spec/testcases/knowledge/listDocumentSourceMemos.md#L8 | snippet が最新内容で返れば PASS（リンクはメモを指す） |
| TC-listDocumentSourceMemos-003 | ソフトデリート済み出典の表示 | spec/testcases/knowledge/listDocumentSourceMemos.md#L9 | deleted:true として一覧に残れば PASS |
| TC-listDocumentSourceMemos-004 | ハードデリート済み出典の非表示 | spec/testcases/knowledge/listDocumentSourceMemos.md#L10 | 一覧に現れなければ PASS（ADR-003） |
| TC-listDocumentSourceMemos-005 | 出典全滅 | spec/testcases/knowledge/listDocumentSourceMemos.md#L11 | sourceMemos:[] になり本文には影響しなければ PASS |
| TC-listDocumentSourceMemos-006 | 出典なしドキュメント | spec/testcases/knowledge/listDocumentSourceMemos.md#L12 | sourceMemos:[] で返れば PASS |
| TC-listDocumentSourceMemos-007 | 一括取得（N+1 回避） | spec/testcases/knowledge/listDocumentSourceMemos.md#L13 | listByIdsIncludingTrashed の 1 クエリで取得されれば PASS |
| TC-listDocumentSourceMemos-008 | ゴミ箱内ドキュメントの出典一覧 | spec/testcases/knowledge/listDocumentSourceMemos.md#L14 | findByIdIncludingTrashed で正常に返れば PASS |
| TC-listDocumentSourceMemos-009 | ドキュメント不在 | spec/testcases/knowledge/listDocumentSourceMemos.md#L15 | NotFoundError なら PASS |
| TC-listDocumentSourceMemos-010 | 他ユーザー所有 | spec/testcases/knowledge/listDocumentSourceMemos.md#L16 | 到達可能性により NotFoundError なら PASS |
| TC-listDocumentSourceMemos-011 | documentId 空文字 | spec/testcases/knowledge/listDocumentSourceMemos.md#L17 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-listDocumentSourceMemos-012 | メモ一括取得 DB 例外 | spec/testcases/knowledge/listDocumentSourceMemos.md#L18 | SystemError(DatabaseError) なら PASS |
| TC-listDocumentsReferencingMemo-001 | 参照元一覧の正常系 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L7 | documentId/title/topicId/deleted:false/linkedAt を持つ 2 件が返れば PASS |
| TC-listDocumentsReferencingMemo-002 | ソフトデリート済み参照元の表示 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L8 | deleted:true として一覧に残れば PASS |
| TC-listDocumentsReferencingMemo-003 | ハードデリート済み参照元の非表示 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L9 | 一覧に現れなければ PASS（ADR-003） |
| TC-listDocumentsReferencingMemo-004 | 参照 0 件 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L10 | documents:[] で返れば PASS |
| TC-listDocumentsReferencingMemo-005 | 一括取得（N+1 回避） | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L11 | listByIdsIncludingTrashed の 1 クエリで取得されれば PASS |
| TC-listDocumentsReferencingMemo-006 | メモ自身がソフトデリート済み | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L12 | findByIdIncludingTrashed で正常に返れば PASS |
| TC-listDocumentsReferencingMemo-007 | メモ不在 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L13 | NotFoundError なら PASS |
| TC-listDocumentsReferencingMemo-008 | 他ユーザー所有 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L14 | 到達可能性により NotFoundError なら PASS |
| TC-listDocumentsReferencingMemo-009 | memoId 空文字 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L15 | MemoId 構築違反で BusinessRuleError なら PASS |
| TC-listDocumentsReferencingMemo-010 | listSourceLinksByMemo DB 例外 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L16 | SystemError(DatabaseError) なら PASS |
| TC-listTopics-001 | 一覧の正常系 | spec/testcases/knowledge/listTopics.md#L7 | active トピックが安定順序で返り documents に配下 active がグルーピングされれば PASS |
| TC-listTopics-002 | includeArchived:true | spec/testcases/knowledge/listTopics.md#L8 | archived を含む全件が返れば PASS |
| TC-listTopics-003 | includeArchived:false | spec/testcases/knowledge/listTopics.md#L9 | active のみ返り archived が含まれなければ PASS |
| TC-listTopics-004 | trashed トピックの除外 | spec/testcases/knowledge/listTopics.md#L10 | includeArchived:true でも trashed は含まれなければ PASS |
| TC-listTopics-005 | トピック 0 件 | spec/testcases/knowledge/listTopics.md#L11 | topics:[] で返れば PASS |
| TC-listTopics-006 | 配下 0 件のトピック | spec/testcases/knowledge/listTopics.md#L12 | documents が空配列なら PASS |
| TC-listTopics-007 | 配下の trashed ドキュメント除外 | spec/testcases/knowledge/listTopics.md#L13 | documents に active のみ含まれれば PASS |
| TC-listTopics-008 | 一括取得（N+1 回避） | spec/testcases/knowledge/listTopics.md#L14 | 配下ドキュメントが listActiveByTopics の 1 クエリで取得されれば PASS |
| TC-listTopics-009 | テナント分離 | spec/testcases/knowledge/listTopics.md#L15 | 他ユーザーのトピック・ドキュメントが一切含まれなければ PASS |
| TC-listTopics-010 | AI 経由の一覧 | spec/testcases/knowledge/listTopics.md#L16 | MCP list_topics が人間 UI と同一結果になれば PASS |
| TC-listTopics-011 | listByUser DB 例外 | spec/testcases/knowledge/listTopics.md#L17 | SystemError(DatabaseError) なら PASS |
| TC-rollbackDocument-001 | ロールバックの正常系 | spec/testcases/knowledge/rollbackDocument.md#L7 | 対象と同内容の新リビジョンが積まれ既存履歴は残り changed:true で、同じ transactionSync でエントリが作り直されれば PASS |
| TC-rollbackDocument-002 | changeReason 省略時の既定値 | spec/testcases/knowledge/rollbackDocument.md#L8 | 「リビジョンNの内容に戻す」が補完されれば PASS |
| TC-rollbackDocument-003 | changeReason 空白のみ | spec/testcases/knowledge/rollbackDocument.md#L9 | 既定値補完で正常にロールバックされれば PASS |
| TC-rollbackDocument-004 | 同一内容への戻し | spec/testcases/knowledge/rollbackDocument.md#L10 | changed:false でリビジョン・エントリの作り直しがなければ PASS |
| TC-rollbackDocument-005 | 最新自身への戻し | spec/testcases/knowledge/rollbackDocument.md#L11 | changed:false なら PASS |
| TC-rollbackDocument-006 | 初版のみで初版へ戻し | spec/testcases/knowledge/rollbackDocument.md#L12 | changed:false なら PASS |
| TC-rollbackDocument-007 | AI 編集後の人間による復元 | spec/testcases/knowledge/rollbackDocument.md#L13 | 新リビジョンの actor が人間ユーザーとして記録されれば PASS |
| TC-rollbackDocument-008 | 存在しないリビジョン番号 | spec/testcases/knowledge/rollbackDocument.md#L14 | NotFoundError なら PASS |
| TC-rollbackDocument-009 | revisionNumber 0 | spec/testcases/knowledge/rollbackDocument.md#L15 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-rollbackDocument-010 | revisionNumber 非整数・負数 | spec/testcases/knowledge/rollbackDocument.md#L16 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-rollbackDocument-011 | changeReason 不正 | spec/testcases/knowledge/rollbackDocument.md#L17 | 改行入り/201文字が対応する BusinessRuleError になれば PASS |
| TC-rollbackDocument-012 | ドキュメント不在 | spec/testcases/knowledge/rollbackDocument.md#L18 | NotFoundError なら PASS |
| TC-rollbackDocument-013 | ゴミ箱内ドキュメント | spec/testcases/knowledge/rollbackDocument.md#L19 | NotFoundError なら PASS |
| TC-rollbackDocument-014 | 他ユーザー所有 | spec/testcases/knowledge/rollbackDocument.md#L20 | 到達可能性により NotFoundError なら PASS |
| TC-rollbackDocument-015 | 別ドキュメントのリビジョン防衛線 | spec/testcases/knowledge/rollbackDocument.md#L21 | BusinessRuleError(RevisionDocumentMismatch) なら PASS |
| TC-rollbackDocument-016 | 並行編集との競合 | spec/testcases/knowledge/rollbackDocument.md#L22 | 0 行更新または一意制約違反で ConflictError なら PASS |
| TC-rollbackDocument-017 | insertRevision DB 例外 | spec/testcases/knowledge/rollbackDocument.md#L23 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-trashDocument-001 | 個別削除の正常系 | spec/testcases/knowledge/trashDocument.md#L7 | trashed/trashedAt:now/trashedWith:null・version+1 で、同じ transactionSync でエントリが除去され出典メモのエントリが作り直されれば PASS |
| TC-trashDocument-002 | 個別削除分はセット復元対象外 | spec/testcases/knowledge/trashDocument.md#L8 | セット復元後も trashedWith:null の項目がゴミ箱に残れば PASS |
| TC-trashDocument-003 | リンク・履歴の保持 | spec/testcases/knowledge/trashDocument.md#L9 | 出典リンク・リビジョンが消えなければ PASS（可逆） |
| TC-trashDocument-004 | ドキュメント不在 | spec/testcases/knowledge/trashDocument.md#L10 | NotFoundError なら PASS |
| TC-trashDocument-005 | 二重削除 | spec/testcases/knowledge/trashDocument.md#L11 | 既に trashed のドキュメントへの再削除が NotFoundError になれば PASS |
| TC-trashDocument-006 | 他ユーザー所有 | spec/testcases/knowledge/trashDocument.md#L12 | 到達可能性により NotFoundError なら PASS |
| TC-trashDocument-007 | documentId 空文字 | spec/testcases/knowledge/trashDocument.md#L13 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-trashDocument-008 | 並行操作との競合 | spec/testcases/knowledge/trashDocument.md#L14 | save 0 行更新で ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-trashDocument-009 | AI 経由の削除 | spec/testcases/knowledge/trashDocument.md#L15 | MCP delete(type:"document") が人間 UI と同一の振る舞いになれば PASS |
| TC-trashDocument-010 | save DB 例外 | spec/testcases/knowledge/trashDocument.md#L16 | SystemError(DatabaseError)・ロールバックで状態遷移もエントリ除去も起きなければ PASS |
| TC-trashDocument-011 | purgeAfter の保存 | spec/testcases/knowledge/trashDocument.md#L17 | RetentionPolicy.expiresAt の算出結果が purgeAfter に保存されれば PASS（trashed ⇔ purgeAfter） |
| TC-trashDocument-012 | purge-trash の起床の投入 | spec/testcases/knowledge/trashDocument.md#L18 | 同じ transactionSync で findEarliestPurgeAfter が読まれ、現在の起床より早ければ purge-trash が投入されれば PASS（5つの投入点の1つ） |
| TC-trashTopic-001 | セット削除の正常系 | spec/testcases/knowledge/trashTopic.md#L7 | トピック trashed + 配下が trashedWith=topic.id で trashed になり、配下 2 件のエントリが同一 transactionSync で除去され、各ドキュメントの出典メモのエントリも作り直されれば PASS |
| TC-trashTopic-002 | archived トピックの削除 | spec/testcases/knowledge/trashTopic.md#L8 | wasArchived:true で trashed になれば PASS |
| TC-trashTopic-003 | 配下 0 件のセット削除 | spec/testcases/knowledge/trashTopic.md#L9 | トピックのみ trashed・trashedDocumentIds:[] で配下のエントリ除去が起きなければ PASS |
| TC-trashTopic-004 | 個別削除済み配下の非対象 | spec/testcases/knowledge/trashTopic.md#L10 | trashedWith:null の項目は変更されず active のみセット対象になれば PASS |
| TC-trashTopic-005 | trashedWith の一致 | spec/testcases/knowledge/trashTopic.md#L11 | セット削除された全配下の trashedWith が topic.id と一致すれば PASS |
| TC-trashTopic-006 | トピック不在 | spec/testcases/knowledge/trashTopic.md#L12 | NotFoundError なら PASS |
| TC-trashTopic-007 | 二重削除 | spec/testcases/knowledge/trashTopic.md#L13 | 既に trashed のトピックへの再削除が NotFoundError になれば PASS |
| TC-trashTopic-008 | 他ユーザー所有 | spec/testcases/knowledge/trashTopic.md#L14 | 到達可能性により NotFoundError なら PASS |
| TC-trashTopic-009 | topicId 空文字 | spec/testcases/knowledge/trashTopic.md#L15 | BusinessRuleError(InvalidTopicId) なら PASS |
| TC-trashTopic-010 | トピック save の競合 | spec/testcases/knowledge/trashTopic.md#L16 | 0 行更新で ConflictError となりトピック・ドキュメントとも不変なら PASS |
| TC-trashTopic-011 | 配下ドキュメント save の競合 | spec/testcases/knowledge/trashTopic.md#L17 | ConflictError で UoW 全体ロールバック・部分セット削除が残らなければ PASS |
| TC-trashTopic-012 | AI 経由の削除 | spec/testcases/knowledge/trashTopic.md#L18 | MCP delete(type:"topic") が人間 UI と同一のセット削除になれば PASS |
| TC-trashTopic-013 | save DB 例外 | spec/testcases/knowledge/trashTopic.md#L19 | SystemError(DatabaseError)・ロールバックで状態遷移もエントリ除去も起きなければ PASS |
| TC-trashTopic-014 | purgeAfter の保存 | spec/testcases/knowledge/trashTopic.md#L20 | トピックと配下ドキュメントに同一の purgeAfter が保存されれば PASS |
| TC-trashTopic-015 | purge-trash の起床の投入 | spec/testcases/knowledge/trashTopic.md#L21 | 同じ transactionSync で findEarliestPurgeAfter が読まれ、現在の起床より早ければ purge-trash が投入されれば PASS（5つの投入点の1つ） |
| TC-updateTopic-001 | rename の正常系 | spec/testcases/knowledge/updateTopic.md#L7 | 名前変更・version+1・status 不変で、検索結果のトピック名が join により次の検索から新しい名前で解決されれば PASS |
| TC-updateTopic-002 | description 変更 | spec/testcases/knowledge/updateTopic.md#L8 | 説明文変更・version+1 なら PASS |
| TC-updateTopic-003 | description null 明示指定 | spec/testcases/knowledge/updateTopic.md#L9 | 説明文が削除され null になれば PASS（省略との区別） |
| TC-updateTopic-004 | アーカイブ遷移 | spec/testcases/knowledge/updateTopic.md#L10 | archived へ遷移すれば PASS（UI 用語は「完了」） |
| TC-updateTopic-005 | アーカイブ解除 | spec/testcases/knowledge/updateTopic.md#L11 | active へ遷移すれば PASS |
| TC-updateTopic-006 | 状態往復 | spec/testcases/knowledge/updateTopic.md#L12 | archive→unarchive の往復が成立し version が 2 回進めば PASS |
| TC-updateTopic-007 | active への冪等指定 | spec/testcases/knowledge/updateTopic.md#L13 | 同状態指定で状態が変わらず version のみ規約どおり進めば PASS |
| TC-updateTopic-008 | archived への冪等指定 | spec/testcases/knowledge/updateTopic.md#L14 | 同状態指定で状態が変わらなければ PASS |
| TC-updateTopic-009 | rename + archive 同時指定 | spec/testcases/knowledge/updateTopic.md#L15 | rename と archive が順に適用されれば PASS |
| TC-updateTopic-010 | archived トピックの rename | spec/testcases/knowledge/updateTopic.md#L16 | rename 成功・archived 維持なら PASS |
| TC-updateTopic-011 | 全フィールド省略 | spec/testcases/knowledge/updateTopic.md#L17 | presentation 層スキーマで ValidationError なら PASS |
| TC-updateTopic-012 | トピック不在 | spec/testcases/knowledge/updateTopic.md#L18 | NotFoundError なら PASS |
| TC-updateTopic-013 | ゴミ箱内トピック | spec/testcases/knowledge/updateTopic.md#L19 | NotFoundError なら PASS（ゴミ箱内は編集不可） |
| TC-updateTopic-014 | 他ユーザー所有 | spec/testcases/knowledge/updateTopic.md#L20 | 到達可能性により NotFoundError なら PASS |
| TC-updateTopic-015 | topicId 空文字 | spec/testcases/knowledge/updateTopic.md#L21 | BusinessRuleError(InvalidTopicId) なら PASS |
| TC-updateTopic-016 | name 不正各種 | spec/testcases/knowledge/updateTopic.md#L22 | 空/改行入り/101文字が対応する BusinessRuleError・トピック不変なら PASS |
| TC-updateTopic-017 | name 100文字境界 | spec/testcases/knowledge/updateTopic.md#L23 | 正常更新されれば PASS |
| TC-updateTopic-018 | description 不正 | spec/testcases/knowledge/updateTopic.md#L24 | 空文字/501文字が対応する BusinessRuleError になれば PASS |
| TC-updateTopic-019 | description 500文字境界 | spec/testcases/knowledge/updateTopic.md#L25 | 正常更新されれば PASS |
| TC-updateTopic-020 | 並行更新の競合 | spec/testcases/knowledge/updateTopic.md#L26 | save 0 行更新で ConflictError・変更未保存なら PASS |
| TC-updateTopic-021 | AI 経由のアーカイブ切替 | spec/testcases/knowledge/updateTopic.md#L27 | MCP update_topic が人間 UI と同一の振る舞いになれば PASS |
| TC-updateTopic-022 | save DB 例外 | spec/testcases/knowledge/updateTopic.md#L28 | SystemError(DatabaseError)・ロールバックで名前・状態のいずれも変更されなければ PASS |
| TC-delete-001 | AI 削除の正常系 | spec/testcases/memo/delete.md#L7 | type:"memo" 指定でメモが trashed/trashedAt:now になり void が返れば PASS（ハードデリート API なし） |
| TC-delete-002 | projection からの除去 | spec/testcases/memo/delete.md#L8 | 同じ transactionSync でエントリが除去され、出典先ドキュメントのエントリも作り直されれば PASS（softDeleteMemo と同一のファンアウト） |
| TC-delete-003 | 人間ゴミ箱への出現 | spec/testcases/memo/delete.md#L9 | AI が削除したメモがゴミ箱に現れ人間が復元できれば PASS |
| TC-delete-004 | データ保持（可逆） | spec/testcases/memo/delete.md#L10 | 本文・全リビジョン・postedAt が保持されれば PASS |
| TC-delete-005 | 削除後の AI 参照不可 | spec/testcases/memo/delete.md#L11 | get で NotFoundError・recent_memos に含まれなければ PASS |
| TC-delete-006 | メモ不在 | spec/testcases/memo/delete.md#L12 | NotFoundError なら PASS |
| TC-delete-007 | 二重削除 | spec/testcases/memo/delete.md#L13 | 不在と区別のつかない NotFoundError なら PASS |
| TC-delete-008 | 他ユーザー所有 | spec/testcases/memo/delete.md#L14 | NotFoundError（不在と区別しない）なら PASS |
| TC-delete-009 | memoId 空文字 | spec/testcases/memo/delete.md#L15 | MemoId.create の非空制約でバリデーションエラーなら PASS |
| TC-delete-010 | 割り込み書き込みの競合 | spec/testcases/memo/delete.md#L16 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-delete-011 | 失効・スコープ外トークン | spec/testcases/memo/delete.md#L17 | 境界で認可エラーとなりユースケースに到達しなければ PASS |
| TC-delete-012 | save DB 例外 | spec/testcases/memo/delete.md#L18 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-delete-013 | purgeAfter の保存 | spec/testcases/memo/delete.md#L19 | AI 経路でも purgeAfter が人間 UI と同じ値で保存されれば PASS |
| TC-delete-014 | purge-trash の起床の投入 | spec/testcases/memo/delete.md#L20 | AI 経路でも同じ transactionSync で findEarliestPurgeAfter が読まれ purge-trash が投入されれば PASS（5つの投入点の1つ） |
| TC-diffMemoRevisions-001 | 二点取得の正常系 | spec/testcases/memo/diffMemoRevisions.md#L7 | base/target の RevisionView（全文スナップショット含む）が返り差分計算はされなければ PASS |
| TC-diffMemoRevisions-002 | 逆順指定 | spec/testcases/memo/diffMemoRevisions.md#L8 | 指定どおりの base/target で返れば PASS |
| TC-diffMemoRevisions-003 | AI 編集リビジョンの actor | spec/testcases/memo/diffMemoRevisions.md#L9 | actor が { kind:"aiClient", clientName } で返れば PASS |
| TC-diffMemoRevisions-004 | 最小の二点 | spec/testcases/memo/diffMemoRevisions.md#L10 | 番号 1 を含む二点が正常に返れば PASS |
| TC-diffMemoRevisions-005 | trashed メモの二点取得 | spec/testcases/memo/diffMemoRevisions.md#L11 | ゴミ箱内メモでも正常に返れば PASS |
| TC-diffMemoRevisions-006 | 同一番号の二点指定 | spec/testcases/memo/diffMemoRevisions.md#L12 | ValidationError なら PASS |
| TC-diffMemoRevisions-007 | 存在しない番号 | spec/testcases/memo/diffMemoRevisions.md#L13 | NotFoundError なら PASS |
| TC-diffMemoRevisions-008 | メモ不在 | spec/testcases/memo/diffMemoRevisions.md#L14 | NotFoundError なら PASS |
| TC-diffMemoRevisions-009 | 他ユーザー所有 | spec/testcases/memo/diffMemoRevisions.md#L15 | 到達可能性により NotFoundError なら PASS |
| TC-diffMemoRevisions-010 | baseRevisionNumber 0 | spec/testcases/memo/diffMemoRevisions.md#L16 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffMemoRevisions-011 | 負数・非整数 | spec/testcases/memo/diffMemoRevisions.md#L17 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffMemoRevisions-012 | memoId 空文字 | spec/testcases/memo/diffMemoRevisions.md#L18 | バリデーションエラーなら PASS |
| TC-diffMemoRevisions-013 | AI トークンからの到達不可 | spec/testcases/memo/diffMemoRevisions.md#L19 | 公開範囲・スコープで構造的に排除されれば PASS |
| TC-diffMemoRevisions-014 | DB 例外 | spec/testcases/memo/diffMemoRevisions.md#L20 | SystemError(DatabaseError) なら PASS |
| TC-editMemo-001 | 編集保存の正常系 | spec/testcases/memo/editMemo.md#L7 | result:"saved" で新本文・version:1・latestRevisionNumber:2 の MemoView が返れば PASS |
| TC-editMemo-002 | 新リビジョンと projection 更新 | spec/testcases/memo/editMemo.md#L8 | 全文スナップショットの新リビジョンが記録され、同じ transactionSync でエントリが作り直されれば PASS |
| TC-editMemo-003 | postedAt 不変 | spec/testcases/memo/editMemo.md#L9 | postedAt 不変・updatedAt が now に更新されれば PASS |
| TC-editMemo-004 | 同一本文の no-op | spec/testcases/memo/editMemo.md#L10 | result:"unchanged" でリビジョン・version・エントリの作り直しがなければ PASS |
| TC-editMemo-005 | 完全一致での等価判定 | spec/testcases/memo/editMemo.md#L11 | 末尾空白 1 文字差でも saved になれば PASS |
| TC-editMemo-006 | AI 介在編集の conflict | spec/testcases/memo/editMemo.md#L12 | result:"conflict" で何も書き込まれず現在状態と latestRevision（AI actor）が返れば PASS |
| TC-editMemo-007 | conflict 後の「そのまま保存」 | spec/testcases/memo/editMemo.md#L13 | currentVersion で再保存すると saved になり AI の編集も履歴に残れば PASS |
| TC-editMemo-008 | 自分の別セッションとの conflict | spec/testcases/memo/editMemo.md#L14 | conflict.latestRevision.actor が { kind:"user" } になれば PASS |
| TC-editMemo-009 | 本文 10,000 文字境界 | spec/testcases/memo/editMemo.md#L15 | result:"saved" なら PASS |
| TC-editMemo-010 | 本文 10,001 文字 | spec/testcases/memo/editMemo.md#L16 | BusinessRuleError(BodyTooLong)・未書き込みなら PASS |
| TC-editMemo-011 | 本文空文字 | spec/testcases/memo/editMemo.md#L17 | BusinessRuleError(EmptyBody) なら PASS |
| TC-editMemo-012 | 本文空白のみ | spec/testcases/memo/editMemo.md#L18 | BusinessRuleError(EmptyBody) なら PASS |
| TC-editMemo-013 | メモ不在 | spec/testcases/memo/editMemo.md#L19 | NotFoundError なら PASS |
| TC-editMemo-014 | trashed メモの編集 | spec/testcases/memo/editMemo.md#L20 | NotFoundError なら PASS（trashed は編集不可） |
| TC-editMemo-015 | 他ユーザー所有 | spec/testcases/memo/editMemo.md#L21 | NotFoundError なら PASS |
| TC-editMemo-016 | memoId 空文字 | spec/testcases/memo/editMemo.md#L22 | バリデーションエラーなら PASS |
| TC-editMemo-017 | expectedVersion 不正 | spec/testcases/memo/editMemo.md#L23 | 負数・非整数でバリデーションエラーなら PASS |
| TC-editMemo-018 | save 直前の割り込み競合 | spec/testcases/memo/editMemo.md#L24 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-editMemo-019 | save/insertRevision DB 例外 | spec/testcases/memo/editMemo.md#L25 | SystemError(DatabaseError)・全ロールバックなら PASS |
| TC-get-001 | AI 取得の正常系 | spec/testcases/memo/get.md#L7 | type:"memo" 指定で { id, body, postedAt, updatedAt, latestRevisionNumber } の全文が返れば PASS |
| TC-get-002 | 編集済みメモの取得 | spec/testcases/memo/get.md#L8 | body が最新リビジョンと一致し latestRevisionNumber が現在値なら PASS |
| TC-get-003 | 上限長本文の取得 | spec/testcases/memo/get.md#L9 | 10,000 文字が切り詰めなしで返れば PASS |
| TC-get-004 | メモ不在 | spec/testcases/memo/get.md#L10 | NotFoundError なら PASS |
| TC-get-005 | trashed は存在しない扱い | spec/testcases/memo/get.md#L11 | 不在と区別のつかない NotFoundError なら PASS |
| TC-get-006 | 他ユーザー所有 | spec/testcases/memo/get.md#L12 | NotFoundError（不在と区別しない）なら PASS |
| TC-get-007 | 種別ディスパッチの取り違え | spec/testcases/memo/get.md#L13 | ドキュメント ID を type:"memo" で指定すると NotFoundError なら PASS |
| TC-get-008 | memoId 空文字 | spec/testcases/memo/get.md#L14 | バリデーションエラーなら PASS |
| TC-get-009 | 失効・スコープ外トークン | spec/testcases/memo/get.md#L15 | 境界で認可エラーとなり到達しなければ PASS |
| TC-get-010 | findById DB 例外 | spec/testcases/memo/get.md#L16 | SystemError(DatabaseError) なら PASS |
| TC-getTimeline-001 | 初期ページ取得 | spec/testcases/memo/getTimeline.md#L7 | cursor:null で postedAt 降順 limit 件と nextCursor が返れば PASS |
| TC-getTimeline-002 | older 方向の継続 | spec/testcases/memo/getTimeline.md#L8 | nextCursor から古い側が重複・欠落なく返れば PASS |
| TC-getTimeline-003 | newer 方向の継続 | spec/testcases/memo/getTimeline.md#L9 | 同カーソルから新しい側が返り nextCursor が新方向を指せば PASS |
| TC-getTimeline-004 | older 側終端 | spec/testcases/memo/getTimeline.md#L10 | 残りが返り nextCursor:null なら PASS |
| TC-getTimeline-005 | newer 側終端 | spec/testcases/memo/getTimeline.md#L11 | nextCursor:null なら PASS |
| TC-getTimeline-006 | 同時刻メモの安定ソート | spec/testcases/memo/getTimeline.md#L12 | id で安定化されページ間の重複・欠落がなければ PASS |
| TC-getTimeline-007 | keyword 絞り込み | spec/testcases/memo/getTimeline.md#L13 | 本文部分一致のメモのみ返れば PASS |
| TC-getTimeline-008 | keyword 空白のみ | spec/testcases/memo/getTimeline.md#L14 | 絞り込みなし扱いで全件対象になれば PASS |
| TC-getTimeline-009 | keyword 一致 0 件 | spec/testcases/memo/getTimeline.md#L15 | items:[] でエラーにならなければ PASS |
| TC-getTimeline-010 | メモ 0 件 | spec/testcases/memo/getTimeline.md#L16 | items:[]・nextCursor:null なら PASS |
| TC-getTimeline-011 | 出典導線の付与 | spec/testcases/memo/getTimeline.md#L17 | sourceDocuments に { documentId, title, isTrashed:false } が含まれれば PASS |
| TC-getTimeline-012 | 複数リンクの一括逆引き | spec/testcases/memo/getTimeline.md#L18 | 全リンク先が含まれ 1 ページ 1 クエリで逆引きされれば PASS |
| TC-getTimeline-013 | trashed リンク先の表示 | spec/testcases/memo/getTimeline.md#L19 | 該当要素が isTrashed:true で返れば PASS |
| TC-getTimeline-014 | ハードデリート済みリンク先 | spec/testcases/memo/getTimeline.md#L20 | sourceDocuments に現れなければ PASS（ADR-003） |
| TC-getTimeline-015 | trashed メモの除外 | spec/testcases/memo/getTimeline.md#L21 | items に含まれなければ PASS |
| TC-getTimeline-016 | テナント分離 | spec/testcases/memo/getTimeline.md#L22 | 他ユーザーのメモが含まれなければ PASS |
| TC-getTimeline-017 | limit 下限境界 | spec/testcases/memo/getTimeline.md#L23 | limit:1 で 1 件だけ返れば PASS |
| TC-getTimeline-018 | limit 上限境界 | spec/testcases/memo/getTimeline.md#L24 | limit:100 で最大 100 件返れば PASS |
| TC-getTimeline-019 | limit 0 | spec/testcases/memo/getTimeline.md#L25 | ValidationError なら PASS |
| TC-getTimeline-020 | limit 101 | spec/testcases/memo/getTimeline.md#L26 | ValidationError なら PASS |
| TC-getTimeline-021 | limit 非整数 | spec/testcases/memo/getTimeline.md#L27 | ValidationError なら PASS |
| TC-getTimeline-022 | cursor デコード不能 | spec/testcases/memo/getTimeline.md#L28 | ValidationError なら PASS |
| TC-getTimeline-023 | newer で cursor なし | spec/testcases/memo/getTimeline.md#L29 | ValidationError なら PASS（newer は cursor 必須） |
| TC-getTimeline-024 | cursor 空文字 | spec/testcases/memo/getTimeline.md#L30 | BusinessRuleError(InvalidCursor) なら PASS |
| TC-getTimeline-025 | findTimelinePage DB 例外 | spec/testcases/memo/getTimeline.md#L31 | SystemError(DatabaseError) なら PASS |
| TC-jumpToDate-001 | 日付ジャンプの正常系 | spec/testcases/memo/jumpToDate.md#L7 | 指定日前後のメモと olderCursor/newerCursor が返れば PASS |
| TC-jumpToDate-002 | ジャンプ後の両方向継続 | spec/testcases/memo/jumpToDate.md#L8 | 両カーソルから重複・欠落なく無限スクロール継続できれば PASS |
| TC-jumpToDate-003 | 指定日にメモなし | spec/testcases/memo/jumpToDate.md#L9 | 前後で最も近いメモの位置が初期ページとして返れば PASS |
| TC-jumpToDate-004 | 全メモより過去の日付 | spec/testcases/memo/jumpToDate.md#L10 | 最古付近の位置が返れば PASS |
| TC-jumpToDate-005 | 全メモより未来の日付 | spec/testcases/memo/jumpToDate.md#L11 | 最新付近の位置が返れば PASS |
| TC-jumpToDate-006 | メモ 0 件 | spec/testcases/memo/jumpToDate.md#L12 | items:[]・両カーソル null でエラーにならなければ PASS |
| TC-jumpToDate-007 | keyword 継続中のジャンプ | spec/testcases/memo/jumpToDate.md#L13 | 絞り込み対象内でアンカー前後が返れば PASS |
| TC-jumpToDate-008 | keyword 一致 0 件 | spec/testcases/memo/jumpToDate.md#L14 | items:[]・両カーソル null なら PASS |
| TC-jumpToDate-009 | 出典導線の付与 | spec/testcases/memo/jumpToDate.md#L15 | sourceDocuments が getTimeline と同一射影で付与されれば PASS |
| TC-jumpToDate-010 | trashed メモの除外 | spec/testcases/memo/jumpToDate.md#L16 | items に含まれなければ PASS |
| TC-jumpToDate-011 | テナント分離 | spec/testcases/memo/jumpToDate.md#L17 | 他ユーザーのメモは含まれず自分のメモで最も近い位置が返れば PASS |
| TC-jumpToDate-012 | limit 下限境界 | spec/testcases/memo/jumpToDate.md#L18 | limit:1 で 1 件だけ返れば PASS |
| TC-jumpToDate-013 | limit 上限境界 | spec/testcases/memo/jumpToDate.md#L19 | limit:100 で最大 100 件返れば PASS |
| TC-jumpToDate-014 | limit 範囲外 | spec/testcases/memo/jumpToDate.md#L20 | 0/101 で ValidationError なら PASS |
| TC-jumpToDate-015 | date 不正 | spec/testcases/memo/jumpToDate.md#L21 | Invalid Date で ValidationError なら PASS |
| TC-jumpToDate-016 | findTimelineAround DB 例外 | spec/testcases/memo/jumpToDate.md#L22 | SystemError(DatabaseError) なら PASS |
| TC-listMemoRevisions-001 | 履歴一覧の正常系 | spec/testcases/memo/listMemoRevisions.md#L7 | revisionNumber 昇順・本文なしメタのみ全件と latestRevisionNumber 一致で返れば PASS |
| TC-listMemoRevisions-002 | actor の区別 | spec/testcases/memo/listMemoRevisions.md#L8 | 人間は kind:"user"・AI は kind:"aiClient"+clientName で区別できれば PASS |
| TC-listMemoRevisions-003 | 初版のみの履歴 | spec/testcases/memo/listMemoRevisions.md#L9 | 初版 1 件のみ返れば PASS |
| TC-listMemoRevisions-004 | trashed メモの履歴 | spec/testcases/memo/listMemoRevisions.md#L10 | findByIdIncludingTrashed 経由で正常に返れば PASS |
| TC-listMemoRevisions-005 | ロールバック後の線形履歴 | spec/testcases/memo/listMemoRevisions.md#L11 | 新リビジョンが含まれ過去も消えず欠番・分岐なしなら PASS |
| TC-listMemoRevisions-006 | メモ不在 | spec/testcases/memo/listMemoRevisions.md#L12 | NotFoundError なら PASS |
| TC-listMemoRevisions-007 | 他ユーザー所有 | spec/testcases/memo/listMemoRevisions.md#L13 | NotFoundError なら PASS |
| TC-listMemoRevisions-008 | memoId 空文字 | spec/testcases/memo/listMemoRevisions.md#L14 | バリデーションエラーなら PASS |
| TC-listMemoRevisions-009 | AI トークンからの到達不可 | spec/testcases/memo/listMemoRevisions.md#L15 | 公開範囲・スコープで構造的に排除され認可エラーなら PASS |
| TC-listMemoRevisions-010 | DB 例外 | spec/testcases/memo/listMemoRevisions.md#L16 | SystemError(DatabaseError) なら PASS |
| TC-postMemo-001 | 投稿の正常系 | spec/testcases/memo/postMemo.md#L7 | MemoView（latestRevisionNumber:1, version:0）が返り postedAt=clock.now() なら PASS |
| TC-postMemo-002 | 初版リビジョンの同時記録 | spec/testcases/memo/postMemo.md#L8 | revisionNumber:1・人間 actor のリビジョンが同一 UoW で記録されれば PASS |
| TC-postMemo-003 | projection への反映 | spec/testcases/memo/postMemo.md#L9 | 同じ transactionSync でエントリが search_entries / search_fts に作られ、直後の検索からヒットすれば PASS |
| TC-postMemo-004 | 前後空白の保存 | spec/testcases/memo/postMemo.md#L10 | trim は空判定のみで本文は入力そのまま保存されれば PASS |
| TC-postMemo-005 | 改行・Markdown の非解釈 | spec/testcases/memo/postMemo.md#L11 | 非構造プレーンテキストとしてそのまま保存されれば PASS |
| TC-postMemo-006 | 1 文字投稿 | spec/testcases/memo/postMemo.md#L12 | 正常作成されれば PASS |
| TC-postMemo-007 | 10,000 文字境界 | spec/testcases/memo/postMemo.md#L13 | 正常作成されれば PASS |
| TC-postMemo-008 | 10,001 文字 | spec/testcases/memo/postMemo.md#L14 | BusinessRuleError(BodyTooLong)・非作成なら PASS |
| TC-postMemo-009 | 空文字 | spec/testcases/memo/postMemo.md#L15 | BusinessRuleError(EmptyBody)・非作成なら PASS |
| TC-postMemo-010 | 空白のみ | spec/testcases/memo/postMemo.md#L16 | BusinessRuleError(EmptyBody) なら PASS |
| TC-postMemo-011 | コードポイント数での上限判定 | spec/testcases/memo/postMemo.md#L17 | サロゲートペア込み 10,000 コードポイントが正常作成されれば PASS |
| TC-postMemo-012 | 同一本文の連続投稿 | spec/testcases/memo/postMemo.md#L18 | 2 件の独立したメモが作成されれば PASS（重複制約なし） |
| TC-postMemo-013 | insert DB 例外 | spec/testcases/memo/postMemo.md#L19 | SystemError(DatabaseError)・全ロールバックなら PASS |
| TC-post_memo-001 | AI 投稿の正常系 | spec/testcases/memo/post_memo.md#L7 | { id, body, postedAt } が返り postedAt 自動付与なら PASS |
| TC-post_memo-002 | AI actor の初版リビジョン | spec/testcases/memo/post_memo.md#L8 | actor:{ kind:"aiClient", clientName } の初版が同一 UoW で記録されれば PASS |
| TC-post_memo-003 | projection への反映 | spec/testcases/memo/post_memo.md#L9 | 同じ transactionSync でエントリが search_entries / search_fts に作られ、直後の検索からヒットすれば PASS |
| TC-post_memo-004 | 10,000 文字境界 | spec/testcases/memo/post_memo.md#L10 | 正常作成されれば PASS |
| TC-post_memo-005 | 10,001 文字 | spec/testcases/memo/post_memo.md#L11 | BusinessRuleError(BodyTooLong)・非作成なら PASS |
| TC-post_memo-006 | 空文字 | spec/testcases/memo/post_memo.md#L12 | BusinessRuleError(EmptyBody)・非作成なら PASS |
| TC-post_memo-007 | 空白のみ | spec/testcases/memo/post_memo.md#L13 | BusinessRuleError(EmptyBody) なら PASS |
| TC-post_memo-008 | 1 文字投稿 | spec/testcases/memo/post_memo.md#L14 | 正常作成されれば PASS |
| TC-post_memo-009 | 改行・Markdown の非解釈 | spec/testcases/memo/post_memo.md#L15 | そのまま保存されれば PASS |
| TC-post_memo-010 | 失効・スコープ外トークン | spec/testcases/memo/post_memo.md#L16 | 境界で認可エラーとなり到達しなければ PASS |
| TC-post_memo-011 | insert DB 例外 | spec/testcases/memo/post_memo.md#L17 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-recent_memos-001 | 既定 20 件の取得 | spec/testcases/memo/recent_memos.md#L7 | limit 省略で直近 20 件が postedAt 降順の { id, body, postedAt }[] で返れば PASS |
| TC-recent_memos-002 | 導線・カーソルの非包含 | spec/testcases/memo/recent_memos.md#L8 | sourceDocuments・カーソルが含まれなければ PASS |
| TC-recent_memos-003 | メモ 0 件 | spec/testcases/memo/recent_memos.md#L9 | 空配列が返れば PASS |
| TC-recent_memos-004 | trashed の除外 | spec/testcases/memo/recent_memos.md#L10 | trashed メモが含まれなければ PASS |
| TC-recent_memos-005 | 直近が全て trashed | spec/testcases/memo/recent_memos.md#L11 | 飛ばして active のみ返れば PASS |
| TC-recent_memos-006 | テナント分離 | spec/testcases/memo/recent_memos.md#L12 | 他ユーザーのメモが含まれなければ PASS |
| TC-recent_memos-007 | 件数不足 | spec/testcases/memo/recent_memos.md#L13 | 存在する全 active メモが返れば PASS |
| TC-recent_memos-008 | limit 下限境界 | spec/testcases/memo/recent_memos.md#L14 | limit:1 で最新 1 件のみ返れば PASS |
| TC-recent_memos-009 | limit 上限境界 | spec/testcases/memo/recent_memos.md#L15 | limit:100 で最大 100 件返れば PASS |
| TC-recent_memos-010 | limit 0 | spec/testcases/memo/recent_memos.md#L16 | ValidationError なら PASS |
| TC-recent_memos-011 | limit 101 | spec/testcases/memo/recent_memos.md#L17 | ValidationError なら PASS |
| TC-recent_memos-012 | limit 非整数 | spec/testcases/memo/recent_memos.md#L18 | ValidationError なら PASS |
| TC-recent_memos-013 | 失効・スコープ外トークン | spec/testcases/memo/recent_memos.md#L19 | 境界で認可エラーとなり到達しなければ PASS |
| TC-recent_memos-014 | findTimelinePage DB 例外 | spec/testcases/memo/recent_memos.md#L20 | SystemError(DatabaseError) なら PASS |
| TC-rollbackMemo-001 | ロールバックの正常系 | spec/testcases/memo/rollbackMemo.md#L7 | result:"rolledBack" で対象内容の新リビジョンが積まれ既存履歴は消えなければ PASS |
| TC-rollbackMemo-002 | 新リビジョンと projection 更新 | spec/testcases/memo/rollbackMemo.md#L8 | 新リビジョン記録・version+1・postedAt 不変で、同じ transactionSync でエントリが作り直されれば PASS |
| TC-rollbackMemo-003 | 同一内容の no-op | spec/testcases/memo/rollbackMemo.md#L9 | result:"unchanged" でリビジョン・エントリの作り直しがなければ PASS |
| TC-rollbackMemo-004 | AI 編集直後のロールバック | spec/testcases/memo/rollbackMemo.md#L10 | 競合警告なしで対象内容に戻り AI 編集も履歴に残れば PASS |
| TC-rollbackMemo-005 | 最新リビジョン指定 | spec/testcases/memo/rollbackMemo.md#L11 | result:"unchanged" なら PASS |
| TC-rollbackMemo-006 | 初版への戻し（下限） | spec/testcases/memo/rollbackMemo.md#L12 | targetRevisionNumber:1 で正常なら PASS |
| TC-rollbackMemo-007 | 存在しない番号 | spec/testcases/memo/rollbackMemo.md#L13 | NotFoundError なら PASS |
| TC-rollbackMemo-008 | 番号 0・負数・非整数 | spec/testcases/memo/rollbackMemo.md#L14 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-rollbackMemo-009 | メモ不在 | spec/testcases/memo/rollbackMemo.md#L15 | NotFoundError なら PASS |
| TC-rollbackMemo-010 | trashed メモ | spec/testcases/memo/rollbackMemo.md#L16 | NotFoundError なら PASS（trashed は編集不可） |
| TC-rollbackMemo-011 | 他ユーザー所有 | spec/testcases/memo/rollbackMemo.md#L17 | NotFoundError なら PASS |
| TC-rollbackMemo-012 | 別メモのリビジョン防衛線 | spec/testcases/memo/rollbackMemo.md#L18 | BusinessRuleError(RevisionMismatch) なら PASS |
| TC-rollbackMemo-013 | memoId 空文字 | spec/testcases/memo/rollbackMemo.md#L19 | バリデーションエラーなら PASS |
| TC-rollbackMemo-014 | 割り込み書き込みの競合 | spec/testcases/memo/rollbackMemo.md#L20 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-rollbackMemo-015 | AI トークンからの到達不可 | spec/testcases/memo/rollbackMemo.md#L21 | 公開範囲・スコープで構造的に排除されれば PASS |
| TC-rollbackMemo-016 | save/insertRevision DB 例外 | spec/testcases/memo/rollbackMemo.md#L22 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-showMemoInTimeline-001 | 対象表示の正常系 | spec/testcases/memo/showMemoInTimeline.md#L7 | targetState:"found" で対象を含む前後ページと両カーソル・targetMemoId が返れば PASS |
| TC-showMemoInTimeline-002 | 対象が最新メモ | spec/testcases/memo/showMemoInTimeline.md#L8 | found で newerCursor:null なら PASS |
| TC-showMemoInTimeline-003 | 対象が最古メモ | spec/testcases/memo/showMemoInTimeline.md#L9 | found で olderCursor:null なら PASS |
| TC-showMemoInTimeline-004 | 対象が唯一のメモ | spec/testcases/memo/showMemoInTimeline.md#L10 | items 1 件・両カーソル null なら PASS |
| TC-showMemoInTimeline-005 | カーソルからの継続 | spec/testcases/memo/showMemoInTimeline.md#L11 | 両方向へ重複・欠落なく閲覧継続できれば PASS |
| TC-showMemoInTimeline-006 | 出典導線の付与 | spec/testcases/memo/showMemoInTimeline.md#L12 | sourceDocuments が getTimeline と同一射影で付与されれば PASS |
| TC-showMemoInTimeline-007 | 対象が trashed | spec/testcases/memo/showMemoInTimeline.md#L13 | targetState:"trashed"・items:[]・両カーソル null でエラーにしないなら PASS |
| TC-showMemoInTimeline-008 | 対象不在 | spec/testcases/memo/showMemoInTimeline.md#L14 | targetState:"notFound"・items:[] でエラーにしないなら PASS |
| TC-showMemoInTimeline-009 | 他ユーザー所有 | spec/testcases/memo/showMemoInTimeline.md#L15 | targetState:"notFound"（所有の事実も漏らさない）なら PASS |
| TC-showMemoInTimeline-010 | limit 境界（正常） | spec/testcases/memo/showMemoInTimeline.md#L16 | limit:1/100 で正常に返れば PASS |
| TC-showMemoInTimeline-011 | limit 範囲外 | spec/testcases/memo/showMemoInTimeline.md#L17 | 0/101 で ValidationError なら PASS |
| TC-showMemoInTimeline-012 | memoId 空文字 | spec/testcases/memo/showMemoInTimeline.md#L18 | バリデーションエラーなら PASS |
| TC-showMemoInTimeline-013 | DB 例外 | spec/testcases/memo/showMemoInTimeline.md#L19 | SystemError(DatabaseError) なら PASS |
| TC-softDeleteMemo-001 | ソフトデリートの正常系 | spec/testcases/memo/softDeleteMemo.md#L7 | trashed/trashedAt:now/version+1/updatedAt:now になり void なら PASS |
| TC-softDeleteMemo-002 | projection からの除去 | spec/testcases/memo/softDeleteMemo.md#L8 | 同じ transactionSync でエントリが除去され、出典先ドキュメントのエントリが作り直されれば PASS |
| TC-softDeleteMemo-003 | タイムラインからの消失 | spec/testcases/memo/softDeleteMemo.md#L9 | getTimeline に含まれなければ PASS |
| TC-softDeleteMemo-004 | データ保持（可逆） | spec/testcases/memo/softDeleteMemo.md#L10 | 本文・全リビジョン・postedAt が保持されれば PASS |
| TC-softDeleteMemo-005 | 出典リンクの保持 | spec/testcases/memo/softDeleteMemo.md#L11 | リンクが残り参照元で「削除済みのメモ」表示になれば PASS |
| TC-softDeleteMemo-006 | メモ不在 | spec/testcases/memo/softDeleteMemo.md#L12 | NotFoundError なら PASS |
| TC-softDeleteMemo-007 | 二重削除 | spec/testcases/memo/softDeleteMemo.md#L13 | NotFoundError（不在と同じ扱い）なら PASS |
| TC-softDeleteMemo-008 | 他ユーザー所有 | spec/testcases/memo/softDeleteMemo.md#L14 | NotFoundError なら PASS |
| TC-softDeleteMemo-009 | memoId 空文字 | spec/testcases/memo/softDeleteMemo.md#L15 | バリデーションエラーなら PASS |
| TC-softDeleteMemo-010 | 割り込み書き込みの競合 | spec/testcases/memo/softDeleteMemo.md#L16 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-softDeleteMemo-011 | save DB 例外 | spec/testcases/memo/softDeleteMemo.md#L17 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-softDeleteMemo-012 | purgeAfter の保存 | spec/testcases/memo/softDeleteMemo.md#L18 | RetentionPolicy.expiresAt の算出結果が purgeAfter に保存されれば PASS（trashed ⇔ purgeAfter） |
| TC-softDeleteMemo-013 | purge-trash の起床の投入 | spec/testcases/memo/softDeleteMemo.md#L19 | 同じ transactionSync で findEarliestPurgeAfter が読まれ、現在の起床より早ければ purge-trash が投入されれば PASS（5つの投入点の1つ） |
| TC-update_memo-001 | AI 全文更新の正常系 | spec/testcases/memo/update_memo.md#L7 | result:"saved" で新本文・latestRevisionNumber:2（全文置換のみ・パッチ非対応）なら PASS |
| TC-update_memo-002 | AI actor のリビジョンと projection 更新 | spec/testcases/memo/update_memo.md#L8 | AI actor の新リビジョンが記録され、同じ transactionSync でエントリが作り直されれば PASS |
| TC-update_memo-003 | postedAt 不変 | spec/testcases/memo/update_memo.md#L9 | postedAt が変わらなければ PASS |
| TC-update_memo-004 | 同一本文の no-op | spec/testcases/memo/update_memo.md#L10 | result:"unchanged" でリビジョン・version・エントリの作り直しがなければ PASS |
| TC-update_memo-005 | 人間編集中の AI 更新 | spec/testcases/memo/update_memo.md#L11 | expectedVersion なしで最新に適用され saved・履歴で追跡可能なら PASS |
| TC-update_memo-006 | 10,000 文字境界 | spec/testcases/memo/update_memo.md#L12 | result:"saved" なら PASS |
| TC-update_memo-007 | 10,001 文字 | spec/testcases/memo/update_memo.md#L13 | BusinessRuleError(BodyTooLong)・未書き込みなら PASS |
| TC-update_memo-008 | 空文字 | spec/testcases/memo/update_memo.md#L14 | BusinessRuleError(EmptyBody) なら PASS |
| TC-update_memo-009 | 空白のみ | spec/testcases/memo/update_memo.md#L15 | BusinessRuleError(EmptyBody) なら PASS |
| TC-update_memo-010 | メモ不在 | spec/testcases/memo/update_memo.md#L16 | NotFoundError なら PASS |
| TC-update_memo-011 | trashed は存在しない扱い | spec/testcases/memo/update_memo.md#L17 | 不在と区別のつかない NotFoundError なら PASS |
| TC-update_memo-012 | 他ユーザー所有 | spec/testcases/memo/update_memo.md#L18 | NotFoundError（不在と区別しない）なら PASS |
| TC-update_memo-013 | memoId 空文字 | spec/testcases/memo/update_memo.md#L19 | バリデーションエラーなら PASS |
| TC-update_memo-014 | UoW 内競合 | spec/testcases/memo/update_memo.md#L20 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-update_memo-015 | 失効・スコープ外トークン | spec/testcases/memo/update_memo.md#L21 | 境界で認可エラーとなり到達しなければ PASS |
| TC-update_memo-016 | save/insertRevision DB 例外 | spec/testcases/memo/update_memo.md#L22 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-search-001 | 検索の正常系 | spec/testcases/search/search.md#L7 | SearchOutput（items/count/nextCursor）が返り、各項目が所定フィールドを持ち count が総件数なら PASS |
| TC-search-002 | topicName の一括解決 | spec/testcases/search/search.md#L8 | listByIds 1 回で全ヒットに topicName が付与されれば PASS（N+1 回避） |
| TC-search-003 | メモ項目の sourceOfDocumentIds | spec/testcases/search/search.md#L9 | active な出典先ドキュメント ID が含まれれば PASS |
| TC-search-004 | ドキュメント項目の sourceMemoIds | spec/testcases/search/search.md#L10 | active な出典メモ ID が含まれれば PASS |
| TC-search-005 | リンクなし項目の空配列 | spec/testcases/search/search.md#L11 | sourceOfDocumentIds/sourceMemoIds が空配列（null でない）なら PASS |
| TC-search-007 | snippet は原文抜粋 | spec/testcases/search/search.md#L12 | 非空の原文抜粋で全文・要約・言い換えでなければ PASS |
| TC-search-008 | topicId 絞り込み | spec/testcases/search/search.md#L13 | トピック配下ドキュメントとその出典メモのみに絞られれば PASS |
| TC-search-009 | トピック内一致なし | spec/testcases/search/search.md#L14 | items:[] の空結果でエラーにならなければ PASS |
| TC-search-010 | アーカイブ済みトピックのヒット | spec/testcases/search/search.md#L15 | アーカイブ配下のドキュメント・出典メモがヒットすれば PASS |
| TC-search-011 | ゴミ箱内項目の非ヒット | spec/testcases/search/search.md#L16 | ソフトデリートと同一トランザクションで projection から除去済みのためヒットしなければ PASS |
| TC-search-012 | ゴミ箱内ドキュメント ID の非露出 | spec/testcases/search/search.md#L17 | メモ項目の sourceOfDocumentIds に含まれなければ PASS |
| TC-search-013 | ゴミ箱内メモ ID の非露出 | spec/testcases/search/search.md#L18 | ドキュメント項目の sourceMemoIds に含まれなければ PASS |
| TC-search-014 | テナント分離 | spec/testcases/search/search.md#L19 | 自 DO の索引に他ユーザーの行が存在せず結果が空なら PASS |
| TC-search-015 | 一致なしキーワード | spec/testcases/search/search.md#L20 | items:[]・count:0 の空結果が返れば PASS |
| TC-search-016 | キーワードの trim | spec/testcases/search/search.md#L21 | trim 後のキーワードで正常検索されれば PASS |
| TC-search-017 | キーワード500文字境界 | spec/testcases/search/search.md#L22 | trim 後ちょうど500文字で正常検索されれば PASS |
| TC-search-018 | カーソルページング | spec/testcases/search/search.md#L23 | nextCursor で続きを読み、ページ間に重複も欠落も起きず count が一定なら PASS |
| TC-search-019 | limit 下限境界 | spec/testcases/search/search.md#L24 | limit:1 で 1 件・count は総件数なら PASS |
| TC-search-020 | limit 上限境界 | spec/testcases/search/search.md#L25 | limit:100 で正常検索されれば PASS |
| TC-search-021 | 最終ページの続き | spec/testcases/search/search.md#L26 | 最終ページの nextCursor でさらに読むと items:[]・nextCursor:undefined になり、エラーにならなければ PASS |
| TC-search-023 | キーワード空文字 | spec/testcases/search/search.md#L27 | BusinessRuleError(EmptyKeyword)・検索未実行なら PASS |
| TC-search-024 | キーワード空白のみ | spec/testcases/search/search.md#L28 | BusinessRuleError(EmptyKeyword) なら PASS |
| TC-search-025 | キーワード501文字 | spec/testcases/search/search.md#L29 | BusinessRuleError(KeywordTooLong) なら PASS |
| TC-search-026 | userId 形式不正 | spec/testcases/search/search.md#L30 | 値オブジェクト構築エラーで query が呼ばれなければ PASS |
| TC-search-027 | topicId 形式不正 | spec/testcases/search/search.md#L31 | バリデーションエラーで query が呼ばれなければ PASS |
| TC-search-030 | limit 0 | spec/testcases/search/search.md#L32 | SearchQuery.create の構築エラーなら PASS |
| TC-search-031 | limit 101 | spec/testcases/search/search.md#L33 | SearchQuery.create の構築エラーなら PASS |
| TC-search-032 | インデックスストア障害 | spec/testcases/search/search.md#L34 | SystemError(SearchIndexUnavailable)（retryable）が返れば PASS |
| TC-search-033 | 投稿直後のヒット | spec/testcases/search/search.md#L35 | 投稿直後（待ち時間なし）の検索で必ずヒットし、反映待ちが存在しなければ PASS |
| TC-search-034 | 日本語 trigram 一致 | spec/testcases/search/search.md#L36 | 3文字以上の日本語キーワードが trigram の索引一致でヒットすれば PASS |
| TC-search-035 | 短語フォールバック | spec/testcases/search/search.md#L37 | 1文字のキーワードが instr() フォールバック経路でヒットすれば PASS（LIKE/GLOB は使わない） |
| TC-search-036 | 全角・半角の正規化 | spec/testcases/search/search.md#L38 | NFKC 正規化により半角・全角のどちらの表記でも 2 件ともヒットすれば PASS |
| TC-search-037 | 合成済み・結合文字列の正規化 | spec/testcases/search/search.md#L39 | NFKC 正規化で同一の索引語になり 2 件ともヒットすれば PASS |
| TC-search-038 | bm25 とタイトル重み付け | spec/testcases/search/search.md#L40 | タイトル一致が本文のみの一致より上位に来れば PASS（重みの実値は実装側） |
| TC-search-039 | 同点時の安定順位 | spec/testcases/search/search.md#L41 | 同点項目の並びが timestamp DESC, type, id で決まり実行ごとに揺れなければ PASS |
| TC-search-040 | 原文からのスニペット | spec/testcases/search/search.md#L42 | snippet が正規化前の原文から組み立てられれば PASS |
| TC-search-041 | 未知トピックの指定 | spec/testcases/search/search.md#L43 | NotFoundError(TOPIC_NOT_FOUND) となり空結果を返さなければ PASS |
| TC-search-042 | ゴミ箱内トピックの指定 | spec/testcases/search/search.md#L44 | NotFoundError(TOPIC_NOT_FOUND) となり空結果を返さなければ PASS |
| TC-search-043 | 不正・期限切れカーソル | spec/testcases/search/search.md#L45 | BusinessRuleError(SearchErrorCode.InvalidCursor) なら PASS |
| TC-search-044 | カーソル検証の責任分割 | spec/testcases/search/search.md#L46 | 形式不正は SearchQuery.create が落として query が呼ばれず、期限切れは query が判定し、どちらも同じ InvalidCursor になれば PASS |
| TC-search-045 | 編集後に旧語が索引に残らない | spec/testcases/search/search.md#L47 | 編集直後に新語でヒットし旧語でヒットしなければ PASS（同一トランザクションでの引き算と挿入） |
| TC-emptyTrash-001 | 全消去の正常系 | spec/testcases/trash/emptyTrash.md#L7 | 全項目が hardDeleteTrashItem と同一手順（影響先確定→OCC 再取得→ハードデリート→リンク消去→projection 更新）で消去され deletedCount が返れば PASS |
| TC-emptyTrash-002 | セット展開の重複除去 | spec/testcases/trash/emptyTrash.md#L8 | 展開と単独項目の二重出現が和集合で除去され各対象が一度だけ消去されれば PASS |
| TC-emptyTrash-003 | ページ送りでの全件取得 | spec/testcases/trash/emptyTrash.md#L9 | ページサイズ超の項目もページ送りで全件消去されれば PASS |
| TC-emptyTrash-004 | 出典リンクの同期消去 | spec/testcases/trash/emptyTrash.md#L10 | 同一 UoW でリンク消去、同じトランザクションで影響ドキュメントのエントリが作り直されれば PASS（ADR-003） |
| TC-emptyTrash-005 | 空のゴミ箱 | spec/testcases/trash/emptyTrash.md#L11 | エラーにせず deletedCount:0 なら PASS |
| TC-emptyTrash-006 | 並行消去済み項目の no-op | spec/testcases/trash/emptyTrash.md#L12 | 並行する purge-trash ジョブ / hardDeleteTrashItem で消えた項目を no-op として続行すれば PASS |
| TC-emptyTrash-007 | OCC 競合項目のスキップ続行 | spec/testcases/trash/emptyTrash.md#L13 | 失敗を記録して次項目へ進み全体が中断しなければ PASS |
| TC-emptyTrash-008 | 再実行の冪等性 | spec/testcases/trash/emptyTrash.md#L14 | 消去済みは現れず残件のみ消去されれば PASS |
| TC-emptyTrash-009 | 項目ごとの UoW 分離 | spec/testcases/trash/emptyTrash.md#L15 | 項目ごとの同期コールバックで失敗項目のみロールバックされ、成功済み項目の消去が確定していれば PASS |
| TC-emptyTrash-010 | テナント分離 | spec/testcases/trash/emptyTrash.md#L16 | 他ユーザーの項目が対象にならなければ PASS |
| TC-emptyTrash-011 | 未初期化の Durable Object | spec/testcases/trash/emptyTrash.md#L17 | 実在確認を行わず deletedCount:0 を返せば PASS |
| TC-emptyTrash-012 | listTrashItems DB 例外 | spec/testcases/trash/emptyTrash.md#L18 | SystemError(DatabaseError) なら PASS |
| TC-hardDeleteTrashItem-001 | 出典でないメモの消去 | spec/testcases/trash/hardDeleteTrashItem.md#L7 | 本体と全リビジョンが消え、同じトランザクションで当該メモのエントリが projection から除去されれば PASS |
| TC-hardDeleteTrashItem-002 | 出典メモの消去とリンク同期消去 | spec/testcases/trash/hardDeleteTrashItem.md#L8 | 同一 UoW でリンク消去、同じトランザクションでエントリ除去と影響ドキュメント 2 件のエントリ作り直しがあれば PASS（ADR-003） |
| TC-hardDeleteTrashItem-003 | ドキュメント消去 | spec/testcases/trash/hardDeleteTrashItem.md#L9 | 全リビジョン・リンクが同一バッチで消え、同じトランザクションでエントリ除去と出典メモ 2 件のエントリ作り直しがあれば PASS |
| TC-hardDeleteTrashItem-004 | セット配下単独の消去 | spec/testcases/trash/hardDeleteTrashItem.md#L10 | 当該ドキュメントのみ消えトピック・他配下に波及しなければ PASS |
| TC-hardDeleteTrashItem-005 | トピックのセット展開消去 | spec/testcases/trash/hardDeleteTrashItem.md#L11 | expandTargets で配下 2 件も展開され、配下のエントリが同じトランザクションで除去されれば PASS |
| TC-hardDeleteTrashItem-006 | 展開配下の出典リンク処理 | spec/testcases/trash/hardDeleteTrashItem.md#L12 | 各配下の出典確定と、その出典メモのエントリの作り直しがあれば PASS |
| TC-hardDeleteTrashItem-007 | 個別削除分の非対象 | spec/testcases/trash/hardDeleteTrashItem.md#L13 | trashedWith:null の項目は setDocumentIds に含まれず残れば PASS |
| TC-hardDeleteTrashItem-008 | 配下なしトピック | spec/testcases/trash/hardDeleteTrashItem.md#L14 | documentIds:[] に展開されトピックのみ消去されれば PASS |
| TC-hardDeleteTrashItem-009 | 出典全滅ドキュメントの無影響 | spec/testcases/trash/hardDeleteTrashItem.md#L15 | 出典一覧が空になってもドキュメント内容に影響しなければ PASS |
| TC-hardDeleteTrashItem-010 | 期限内の明示消去 | spec/testcases/trash/hardDeleteTrashItem.md#L16 | expiresAt 直前でもユーザー明示操作として消去されれば PASS |
| TC-hardDeleteTrashItem-011 | 並行消去済み対象の no-op | spec/testcases/trash/hardDeleteTrashItem.md#L17 | 並行する emptyTrash / purge-trash ジョブで消えた対象を no-op として続行すれば PASS |
| TC-hardDeleteTrashItem-012 | kind 列挙外 | spec/testcases/trash/hardDeleteTrashItem.md#L18 | バリデーションエラーなら PASS |
| TC-hardDeleteTrashItem-013 | id 空文字 | spec/testcases/trash/hardDeleteTrashItem.md#L19 | バリデーションエラーなら PASS |
| TC-hardDeleteTrashItem-014 | ユーザー不在 | spec/testcases/trash/hardDeleteTrashItem.md#L20 | NotFoundError なら PASS |
| TC-hardDeleteTrashItem-015 | 項目不在 | spec/testcases/trash/hardDeleteTrashItem.md#L21 | NotFoundError なら PASS |
| TC-hardDeleteTrashItem-016 | ゴミ箱外項目の指定 | spec/testcases/trash/hardDeleteTrashItem.md#L22 | NotFoundError なら PASS（直接ハードデリート経路は存在しない） |
| TC-hardDeleteTrashItem-017 | 他ユーザー所有 | spec/testcases/trash/hardDeleteTrashItem.md#L23 | NotFoundError なら PASS |
| TC-hardDeleteTrashItem-018 | 並行復元との競合 | spec/testcases/trash/hardDeleteTrashItem.md#L24 | ConflictError で UoW ロールバック・リンク消去も projection 更新も取り消されれば PASS |
| TC-hardDeleteTrashItem-019 | リポジトリ DB 例外 | spec/testcases/trash/hardDeleteTrashItem.md#L25 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-listTrash-001 | 横断一覧の正常系 | spec/testcases/trash/listTrash.md#L7 | 3 種別横断の TrashItemView[] が削除日時降順で返り trashedAt/expiresAt 付与なら PASS |
| TC-listTrash-002 | メモ項目のフィールド | spec/testcases/trash/listTrash.md#L8 | excerpt を含み他種別フィールドを含まなければ PASS |
| TC-listTrash-003 | 個別削除ドキュメント項目 | spec/testcases/trash/listTrash.md#L9 | title・topicId 付きで deletedWithTopic:false なら PASS |
| TC-listTrash-004 | セット削除の識別 | spec/testcases/trash/listTrash.md#L10 | topic 項目に name/setDocumentIds、配下は deletedWithTopic:true なら PASS |
| TC-listTrash-005 | セット分と個別分の区別 | spec/testcases/trash/listTrash.md#L11 | setDocumentIds はセット分のみ・個別分は deletedWithTopic:false で独立に並べば PASS |
| TC-listTrash-006 | ページング | spec/testcases/trash/listTrash.md#L12 | page:2/limit:10 で 11〜20 件目と正しいメタが返れば PASS |
| TC-listTrash-007 | 範囲外ページ | spec/testcases/trash/listTrash.md#L13 | items 空配列・totalCount 維持でエラーにならなければ PASS |
| TC-listTrash-008 | 空のゴミ箱 | spec/testcases/trash/listTrash.md#L14 | items:[]・totalCount:0 なら PASS |
| TC-listTrash-009 | 既定保持日数での期限算出 | spec/testcases/trash/listTrash.md#L15 | expiresAt にソフトデリート時に保存された purgeAfter（trashedAt + 30日）が載れば PASS |
| TC-listTrash-010 | 保持日数短縮の遡及適用 | spec/testcases/trash/listTrash.md#L16 | 変更と同一トランザクションで purge_after が再計算され expiresAt が trashedAt + 7日 になれば PASS |
| TC-listTrash-011 | 保持日数延長の遡及適用 | spec/testcases/trash/listTrash.md#L17 | 同じ一括再計算により expiresAt が trashedAt + 60日 になれば PASS |
| TC-listTrash-012 | 最小保持日数 | spec/testcases/trash/listTrash.md#L18 | retentionDays:1 で expiresAt > trashedAt を満たせば PASS |
| TC-listTrash-013 | テナント分離 | spec/testcases/trash/listTrash.md#L19 | 到達可能性により他ユーザーの項目が一切含まれなければ PASS |
| TC-listTrash-014 | page 0 | spec/testcases/trash/listTrash.md#L20 | バリデーションエラーなら PASS |
| TC-listTrash-015 | page 非整数 | spec/testcases/trash/listTrash.md#L21 | バリデーションエラーなら PASS |
| TC-listTrash-016 | limit 0 | spec/testcases/trash/listTrash.md#L22 | バリデーションエラーなら PASS |
| TC-listTrash-017 | limit 101 | spec/testcases/trash/listTrash.md#L23 | バリデーションエラーなら PASS |
| TC-listTrash-018 | limit 境界（正常） | spec/testcases/trash/listTrash.md#L24 | limit:1/100 で正常処理されれば PASS |
| TC-listTrash-019 | 未初期化の Durable Object | spec/testcases/trash/listTrash.md#L25 | 実在確認を行わず items:[] / totalCount:0 を返せば PASS |
| TC-listTrash-020 | listTrashItems DB 例外 | spec/testcases/trash/listTrash.md#L26 | SystemError(DatabaseError) なら PASS |
| TC-pruneExpiredTrashItems-001 | 期限切れ消去の正常系 | spec/testcases/trash/pruneExpiredTrashItems.md#L7 | purge-trash ジョブの起床で各項目が展開され、項目ごとの UoW で消去手順と projection 更新が実行され processedCount が返れば PASS |
| TC-pruneExpiredTrashItems-002 | 出典メモのリンク同期消去 | spec/testcases/trash/pruneExpiredTrashItems.md#L8 | 同一 UoW でリンク消去、同じ transactionSync でエントリ除去と影響先ドキュメントのエントリ作り直しがあれば PASS |
| TC-pruneExpiredTrashItems-003 | セット削除トピックの展開 | spec/testcases/trash/pruneExpiredTrashItems.md#L9 | 追加照会なしで setDocumentIds から展開され配下ごと消去されれば PASS |
| TC-pruneExpiredTrashItems-004 | 配下ドキュメント単独の期限切れ | spec/testcases/trash/pruneExpiredTrashItems.md#L10 | 単品ハードデリートとして消去されれば PASS |
| TC-pruneExpiredTrashItems-005 | purgeAfter == now の非対象 | spec/testcases/trash/pruneExpiredTrashItems.md#L11 | 厳密な `<` 判定で消去されなければ PASS |
| TC-pruneExpiredTrashItems-006 | 1ms 過去の対象化 | spec/testcases/trash/pruneExpiredTrashItems.md#L12 | 期限切れとして消去されれば PASS |
| TC-pruneExpiredTrashItems-007 | 期限内項目への不干渉 | spec/testcases/trash/pruneExpiredTrashItems.md#L13 | 自 DO の purge_after 索引が対象を返さず processedCount:0 で一切触れなければ PASS |
| TC-pruneExpiredTrashItems-008 | 短縮の遡及適用 | spec/testcases/trash/pruneExpiredTrashItems.md#L14 | 再計算後の purgeAfter で判定され既存項目も消去されれば PASS |
| TC-pruneExpiredTrashItems-009 | 延長の遡及適用 | spec/testcases/trash/pruneExpiredTrashItems.md#L15 | 再計算の残件が空になった起床でだけ期限判定が行われ、期限内と判定され消去されなければ PASS |
| TC-pruneExpiredTrashItems-011 | chunkLimit × maxChunks での打ち切り | spec/testcases/trash/pruneExpiredTrashItems.md#L16 | 1 チャンク chunkLimit 件・反復 maxChunks 回までで打ち切り、hasMore:true で残りを次回の起床に委ねれば PASS |
| TC-pruneExpiredTrashItems-012 | 再起床の冪等性 | spec/testcases/trash/pruneExpiredTrashItems.md#L17 | 消去済みは駆動源クエリに現れず processedCount:0 なら PASS |
| TC-pruneExpiredTrashItems-013 | 並行消去済みの no-op | spec/testcases/trash/pruneExpiredTrashItems.md#L18 | 行不在の対象を no-op として続行すれば PASS |
| TC-pruneExpiredTrashItems-014 | OCC 競合の先送り | spec/testcases/trash/pruneExpiredTrashItems.md#L19 | 記録して次項目へ進み failedCount に計上されれば PASS |
| TC-pruneExpiredTrashItems-015 | 項目ごとの UoW 分離 | spec/testcases/trash/pruneExpiredTrashItems.md#L20 | 失敗項目のみロールバックされ他は確定していれば PASS |
| TC-pruneExpiredTrashItems-016 | 期限切れ項目の列挙の DB 例外 | spec/testcases/trash/pruneExpiredTrashItems.md#L21 | SystemError(DatabaseError) で実行終了し次回の起床に委ねれば PASS |
| TC-pruneExpiredTrashItems-017 | chunkLimit / maxChunks 不正 | spec/testcases/trash/pruneExpiredTrashItems.md#L22 | どちらも 0 または非整数でバリデーションエラーなら PASS（行数上限と反復回数上限は対で置く） |
| TC-pruneExpiredTrashItems-018 | 再計算中の保持日数の再変更 | spec/testcases/trash/pruneExpiredTrashItems.md#L23 | 作業述語が新しい値で定義され直すだけで先頭からやり直さず、有限回の起床で残件が空になれば PASS（永続カーソルを持たない） |
| TC-pruneExpiredTrashItems-019 | maxChunks を使い切った再計算 | spec/testcases/trash/pruneExpiredTrashItems.md#L24 | 再計算を打ち切り削除フェーズへ進まずに hasMore:true を返せば PASS（削除フェーズは残件が空になった起床だけ） |
| TC-restoreDocument-001 | restoreAlone の正常系 | spec/testcases/trash/restoreDocument.md#L9 | トピック touch → restore → save が同一 UoW で行われ restored/restoredTopicId:null、同じトランザクションでエントリが作り直されれば PASS |
| TC-restoreDocument-002 | archived トピックへの単独復元 | spec/testcases/trash/restoreDocument.md#L10 | archived も存命扱いで restoreAlone になれば PASS |
| TC-restoreDocument-003 | 復元による「削除済み」表示の解消 | spec/testcases/trash/restoreDocument.md#L11 | リンク保持のため追加操作なしで表示が解消されれば PASS |
| TC-restoreDocument-004 | 再取得でトピック trashed 化 | spec/testcases/trash/restoreDocument.md#L12 | 書き込まず setRestoreConfirmationRequired を返せば PASS |
| TC-restoreDocument-005 | 再取得でトピックハードデリート化 | spec/testcases/trash/restoreDocument.md#L13 | 書き込まず destinationSelectionRequired を返せば PASS |
| TC-restoreDocument-006 | touch と並行操作の競合 | spec/testcases/trash/restoreDocument.md#L14 | touch 0 行更新で ConflictError となりドキュメント未復元なら PASS |
| TC-restoreDocument-007 | 再取得でドキュメント不在/active | spec/testcases/trash/restoreDocument.md#L15 | NotFoundError なら PASS |
| TC-restoreDocument-008 | セット復元の確認要求 | spec/testcases/trash/restoreDocument.md#L21 | confirmSetRestore なしで書き込みゼロ・setRestoreConfirmationRequired と topicId/topicName が返れば PASS |
| TC-restoreDocument-009 | confirmSetRestore:true のセット復元 | spec/testcases/trash/restoreDocument.md#L22 | restoreTopicSet でトピック+配下全件が同一 UoW で復元され、復元された全ドキュメントのエントリが作り直されれば PASS |
| TC-restoreDocument-010 | wasArchived トピックのセット復元 | spec/testcases/trash/restoreDocument.md#L23 | トピックが archived 状態へ戻りセット復元も実行されれば PASS |
| TC-restoreDocument-011 | 個別削除分の要求対象の必須復元 | spec/testcases/trash/restoreDocument.md#L24 | skippedDocuments 分類でも要求対象は追加 restore で必ず復元されれば PASS |
| TC-restoreDocument-012 | 他の個別削除分の残置 | spec/testcases/trash/restoreDocument.md#L25 | 要求対象以外の skippedDocuments はゴミ箱に残れば PASS |
| TC-restoreDocument-013 | 確認中にトピック復元済み | spec/testcases/trash/restoreDocument.md#L26 | 現況再判定で restoreAlone 相当として処理されれば PASS |
| TC-restoreDocument-014 | 確認中にトピックハードデリート | spec/testcases/trash/restoreDocument.md#L27 | 再判定で destinationSelectionRequired を返せば PASS |
| TC-restoreDocument-015 | listTrashedByTopic 不整合の防衛 | spec/testcases/trash/restoreDocument.md#L28 | BusinessRuleError(TrashedWithMismatch) なら PASS |
| TC-restoreDocument-016 | セット復元の OCC 競合 | spec/testcases/trash/restoreDocument.md#L29 | ConflictError で UoW 全体ロールバックなら PASS |
| TC-restoreDocument-017 | 復元先選択の要求 | spec/testcases/trash/restoreDocument.md#L35 | destination 省略時に書き込みゼロで destinationSelectionRequired を返せば PASS |
| TC-restoreDocument-018 | 既存トピックへの復元 | spec/testcases/trash/restoreDocument.md#L36 | touch → moveToTopic（trashedWith null 化）→ restore が同一 UoW で行われ restoredTopicId が返れば PASS |
| TC-restoreDocument-019 | 新規トピックへの復元 | spec/testcases/trash/restoreDocument.md#L37 | 新規トピック作成後に移動・復元され、同じトランザクションで当該ドキュメントのエントリが作り直されれば PASS |
| TC-restoreDocument-020 | 新規トピック description 省略 | spec/testcases/trash/restoreDocument.md#L38 | description:null で作成・復元されれば PASS |
| TC-restoreDocument-021 | 復元先トピック不正 | spec/testcases/trash/restoreDocument.md#L39 | 不在/ゴミ箱内/他ユーザーの existing 指定が NotFoundError なら PASS |
| TC-restoreDocument-022 | 復元先 touch の競合 | spec/testcases/trash/restoreDocument.md#L40 | touch 0 行更新で ConflictError・未復元なら PASS |
| TC-restoreDocument-023 | destination.topicId 形式不正 | spec/testcases/trash/restoreDocument.md#L41 | バリデーションエラーなら PASS |
| TC-restoreDocument-024 | 新規トピック name 不正 | spec/testcases/trash/restoreDocument.md#L42 | 空/改行/101文字でバリデーションエラーなら PASS |
| TC-restoreDocument-025 | 新規トピック name 100文字境界 | spec/testcases/trash/restoreDocument.md#L43 | 正常に復元されれば PASS |
| TC-restoreDocument-026 | 新規トピック description 501文字 | spec/testcases/trash/restoreDocument.md#L44 | バリデーションエラーなら PASS |
| TC-restoreDocument-027 | 新規トピック description 500文字境界 | spec/testcases/trash/restoreDocument.md#L45 | 正常に復元されれば PASS |
| TC-restoreDocument-028 | documentId 空文字 | spec/testcases/trash/restoreDocument.md#L51 | バリデーションエラーなら PASS |
| TC-restoreDocument-029 | ユーザー不在 | spec/testcases/trash/restoreDocument.md#L52 | NotFoundError なら PASS |
| TC-restoreDocument-030 | 対象が不在/active/他ユーザー所有 | spec/testcases/trash/restoreDocument.md#L53 | findTrashItem が null を返し NotFoundError なら PASS |
| TC-restoreDocument-031 | 期限間近の復元可能性 | spec/testcases/trash/restoreDocument.md#L54 | 期限内なら通常どおり復元されれば PASS |
| TC-restoreDocument-032 | purge-trash ジョブ等との並行競合 | spec/testcases/trash/restoreDocument.md#L55 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-restoreDocument-033 | DB 例外 | spec/testcases/trash/restoreDocument.md#L56 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-restoreDocument-034 | purgeAfter の解除 | spec/testcases/trash/restoreDocument.md#L57 | 3 分岐のいずれでも復元で purgeAfter が落ちれば PASS |
| TC-restoreMemo-001 | 復元の正常系 | spec/testcases/trash/restoreMemo.md#L7 | ActiveMemo へ遷移・保存され memoId が返れば PASS |
| TC-restoreMemo-002 | 元の位置への復帰 | spec/testcases/trash/restoreMemo.md#L8 | postedAt 不変でタイムラインの元の位置に戻れば PASS |
| TC-restoreMemo-003 | 出典メモの復元 | spec/testcases/trash/restoreMemo.md#L9 | リンク保持のまま復元され、同一トランザクションで当該メモと出典先ドキュメントのエントリが作り直されれば PASS |
| TC-restoreMemo-004 | 期限間近の復元可能性 | spec/testcases/trash/restoreMemo.md#L10 | 期限内なら通常どおり復元されれば PASS |
| TC-restoreMemo-005 | memoId 空文字 | spec/testcases/trash/restoreMemo.md#L11 | バリデーションエラーなら PASS |
| TC-restoreMemo-006 | メモ不在 | spec/testcases/trash/restoreMemo.md#L12 | NotFoundError なら PASS |
| TC-restoreMemo-007 | active メモの復元要求 | spec/testcases/trash/restoreMemo.md#L13 | NotFoundError なら PASS |
| TC-restoreMemo-008 | 他ユーザー所有 | spec/testcases/trash/restoreMemo.md#L14 | 到達可能性により NotFoundError なら PASS |
| TC-restoreMemo-009 | ハードデリート済み | spec/testcases/trash/restoreMemo.md#L15 | NotFoundError なら PASS |
| TC-restoreMemo-010 | 並行操作との競合 | spec/testcases/trash/restoreMemo.md#L16 | ConflictError・ロールバックで projection も更新されなければ PASS |
| TC-restoreMemo-011 | リポジトリ DB 例外 | spec/testcases/trash/restoreMemo.md#L17 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-restoreMemo-012 | purgeAfter の解除 | spec/testcases/trash/restoreMemo.md#L18 | 復元で trashedAt とともに purgeAfter が落ちれば PASS（起床の駆動源が過去へ固定されない） |
| TC-restoreTopic-001 | セット復元の正常系 | spec/testcases/trash/restoreTopic.md#L7 | トピックと配下 2 件が同一 UoW で復元され restoredDocumentIds が返り、配下のエントリが作り直されれば PASS |
| TC-restoreTopic-002 | active への復帰 | spec/testcases/trash/restoreTopic.md#L8 | wasArchived:false のトピックが active に戻れば PASS |
| TC-restoreTopic-003 | archived への復帰 | spec/testcases/trash/restoreTopic.md#L9 | wasArchived:true のトピックが archived に戻れば PASS |
| TC-restoreTopic-004 | 配下 0 件のセット復元 | spec/testcases/trash/restoreTopic.md#L10 | トピックのみ復元・restoredDocumentIds:[] で projection の更新が起きなければ PASS |
| TC-restoreTopic-005 | 個別削除分の残置 | spec/testcases/trash/restoreTopic.md#L11 | セット分のみ復元され trashedWith:null 分はゴミ箱に残れば PASS |
| TC-restoreTopic-006 | 期限間近の復元可能性 | spec/testcases/trash/restoreTopic.md#L12 | 期限内なら通常どおりセット復元されれば PASS |
| TC-restoreTopic-007 | topicId 空文字 | spec/testcases/trash/restoreTopic.md#L13 | バリデーションエラーなら PASS |
| TC-restoreTopic-008 | トピック不在 | spec/testcases/trash/restoreTopic.md#L14 | NotFoundError なら PASS |
| TC-restoreTopic-009 | active/archived トピックの復元要求 | spec/testcases/trash/restoreTopic.md#L15 | ゴミ箱にないため NotFoundError なら PASS |
| TC-restoreTopic-010 | 他ユーザー所有 | spec/testcases/trash/restoreTopic.md#L16 | NotFoundError なら PASS |
| TC-restoreTopic-011 | listTrashedByTopic 不整合の防衛 | spec/testcases/trash/restoreTopic.md#L17 | BusinessRuleError(TrashedWithMismatch) なら PASS |
| TC-restoreTopic-012 | 並行操作（ハードデリート・purge-trash ジョブ・別の復元）との競合 | spec/testcases/trash/restoreTopic.md#L18 | ConflictError で UoW 全体ロールバック・部分復元なしなら PASS |
| TC-restoreTopic-013 | リポジトリ DB 例外 | spec/testcases/trash/restoreTopic.md#L19 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-restoreTopic-014 | purgeAfter の解除 | spec/testcases/trash/restoreTopic.md#L20 | トピック・配下ドキュメントとも purgeAfter が落ちれば PASS |
| TC-outboxDelivery-001 | 3つが同じ transactionSync で確定する | spec/testcases/async/outboxDelivery.md#L9 | 業務データ・FTS5 projection・outbox_events の行が同じ transactionSync の中で一度に確定すれば PASS |
| TC-outboxDelivery-002 | rollback で3つとも巻き戻る | spec/testcases/async/outboxDelivery.md#L10 | 業務データの失敗でイベント行も projection も巻き戻り、イベント行だけが残らなければ PASS |
| TC-outboxDelivery-003 | FTS5 projection は配送を待たない | spec/testcases/async/outboxDelivery.md#L11 | relay や Queue の状態と独立に、作成・更新の直後の検索でヒットすれば PASS |
| TC-outboxDelivery-004 | relay の相1（claim） | spec/testcases/async/outboxDelivery.md#L12 | 実行可能な行が next_run_at の昇順で上限件数まで publishing になり lease_until / owner_token が CAS で書かれ、打ち切りで残るのが常により後の next_run_at の行なら PASS |
| TC-outboxDelivery-005 | relay の相2〜相3（publish と終端） | spec/testcases/async/outboxDelivery.md#L13 | Queue 送信だけがトランザクション外で行われ、published へ落ちても owner_token が NULL にならなければ PASS |
| TC-outboxDelivery-006 | Alarm の多重化 | spec/testcases/async/outboxDelivery.md#L14 | 2表の最早時刻の min が張られ、両方の実行可能集合が空のときだけ deleteAlarm されれば PASS |
| TC-outboxDelivery-007 | lease 中の行の算入 | spec/testcases/async/outboxDelivery.md#L15 | leased 行が max(next_run_at, lease_until) で算入され、空振り起床を繰り返さなければ PASS |
| TC-outboxDelivery-008 | DO reset による再 claim と再 publish | spec/testcases/async/outboxDelivery.md#L16 | lease 満了後に再 claim・再 publish され、古いメッセージ側の RPC が nothing-to-send、新しい側が send を返せば PASS |
| TC-outboxDelivery-009 | 重複配送の冪等化 | spec/testcases/async/outboxDelivery.md#L17 | 2回とも send でも providerIdempotencyKey が同じ値で provider 側が抑止し、consumer が EventId を保持しなければ PASS |
| TC-outboxDelivery-010 | 順序逆転した2件の配送 | spec/testcases/async/outboxDelivery.md#L18 | 新しいほうが send、古いほうが nothing-to-send で、どちらも ack されれば PASS（理由は期待値に書けない） |
| TC-outboxDelivery-011 | publish 失敗の行単位 backoff | spec/testcases/async/outboxDelivery.md#L19 | 失敗した行だけが attempt を進めて先送りされ、同じ起床の他の行が止まらなければ PASS |
| TC-outboxDelivery-012 | alarm() から throw しない | spec/testcases/async/outboxDelivery.md#L20 | per-row catch で失敗が吸収され、残りの outbox 行と jobs パスが実行され Alarm が張り直されれば PASS |
| TC-outboxDelivery-013 | 上限超過での quarantine | spec/testcases/async/outboxDelivery.md#L21 | quarantined + terminal_reason になり、terminal_reason に PII と秘密が入らず、以後の起床で再 claim されず（実行可能集合は status IN ('pending','publishing')）他の行の配送が止まらなければ PASS |
| TC-outboxDelivery-014 | quarantined 行への送信材料 RPC | spec/testcases/async/outboxDelivery.md#L22 | 呼び出しガード (b) により nothing-to-send を返せば PASS |
| TC-outboxDelivery-015 | quarantine の一覧 | spec/testcases/async/outboxDelivery.md#L23 | list-quarantined-events で隔離行が一覧でき、jobs.kind にも event.type にも入らなければ PASS |
| TC-outboxDelivery-016 | quarantine の再駆動 | spec/testcases/async/outboxDelivery.md#L24 | requeue-quarantined-event が status='pending' / next_run_at=現在時刻 / attempt=0 / completed_at=NULL を書き、terminal_reason を残し owner_token を採番し直して次の起床で relay の対象になれば PASS |
| TC-outboxDelivery-017 | published の prune と quarantined の保持 | spec/testcases/async/outboxDelivery.md#L25 | 保持期間を過ぎた published だけが上限件数まで削除され、quarantined が残れば PASS |
| TC-outboxDelivery-018 | prune 後の DLQ 再駆動 | spec/testcases/async/outboxDelivery.md#L26 | 呼び出しガード (a) を満たさず nothing-to-send になり、運用値の制約2本で恒久的な空振りが防がれていれば PASS |
| TC-outboxDelivery-019 | consumer 失敗の DLQ 落とし | spec/testcases/async/outboxDelivery.md#L27 | メッセージが DLQ へ落ち、発行元 DO は published のまま ack を書き戻されなければ PASS |
| TC-outboxDelivery-020 | fail-closed の DO は relay しない | spec/testcases/async/outboxDelivery.md#L28 | 行が滞留するが失われず、Alarm が張ったまま残り、コードが揃った次の起床で流れれば PASS |
| TC-outboxDelivery-021 | fail-closed × DLQ の逆向き | spec/testcases/async/outboxDelivery.md#L29 | 送信材料 RPC がゲートで SystemError を返し、retry を焼き切って DLQ へ落ち、再駆動で復旧できれば PASS |
| TC-outboxDelivery-022 | PII と秘密の非露出 | spec/testcases/async/outboxDelivery.md#L30 | payload / Queue / DLQ / ログ / terminal_reason のいずれにも載らず、宛先と生トークンが RPC 応答と provider 呼び出しにしか存在しなければ PASS |
| TC-outboxDelivery-023 | status を照合しない正常系 | spec/testcases/async/outboxDelivery.md#L31 | 送る側（検証材料を持つクレデンシャル宛・トークンが未使用で期限内）の published の行に対して send が返り、二重送信の抑止が providerIdempotencyKey 側にあれば PASS |
| TC-outboxDelivery-024 | イベント行は収束しない | spec/testcases/async/outboxDelivery.md#L32 | 同じ内容のイベントを2回発行すると2行になり、dedupe_key も部分 UNIQUE 索引も無ければ PASS |
| TC-outboxDelivery-025 | relay パスと jobs パスの独立上限 | spec/testcases/async/outboxDelivery.md#L33 | 1回の起床で両方のパスを必ず1回通り、片方の上限到達が他方を飢えさせなければ PASS |
| TC-outboxDelivery-026 | 同じ起床で claim した行の owner_token の相異 | spec/testcases/async/outboxDelivery.md#L34 | 同じ起床で claim された2行以上の owner_token が互いに異なり、暗号論的乱数（128 bit 以上・時刻や連番から導かない）から採られていれば PASS |
