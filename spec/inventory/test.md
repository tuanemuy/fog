# Inventory — test

生成元: spec/testcases/（最終同期: 2026-07-25）

testcases 側にテストケース ID の記載はないため、全行 `TC-{ユースケースslug}-{連番3桁}` で新規採番した。連番はテーブルの行順（`spec/testcases/{パス}` 内の上から下）に対応する。定義場所の `#L{n}` は当該テストケース行の行番号（Read の offset で直接開ける）。

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| TC-exportAllData-001 | 基本構成のエクスポート | spec/testcases/export/exportAllData.md#L7 | zip（filename/contentType 正）が返り、ルートに index.md・memos/ 日別2ファイル・topics/{slug}/（index.md + ドキュメント2ファイル）が含まれれば PASS |
| TC-exportAllData-002 | マニフェスト index.md | spec/testcases/export/exportAllData.md#L8 | frontmatter に type/exportedAt/timezone/counts、本文に対象範囲・非対象の説明があれば PASS |
| TC-exportAllData-003 | 同日メモの日別ファイル | spec/testcases/export/exportAllData.md#L9 | 同日3メモが1ファイルに postedAt 昇順・`## HH:mm (memoId)` 見出し（同一分も別見出し）で並べば PASS |
| TC-exportAllData-004 | timezone 基準の日別グルーピング | spec/testcases/export/exportAllData.md#L10 | UTC 同日でも指定 TZ で別日のメモが別の日別ファイルに分かれれば PASS |
| TC-exportAllData-005 | 本文エスケープなし | spec/testcases/export/exportAllData.md#L11 | `##` で始まる行を含む本文がエスケープなしでそのまま出力されれば PASS |
| TC-exportAllData-006 | トピック index.md の frontmatter | spec/testcases/export/exportAllData.md#L12 | type/topicId/name（引用符付き）/archived/createdAt の frontmatter と description 本文が出力されれば PASS |
| TC-exportAllData-007 | description null のトピック | spec/testcases/export/exportAllData.md#L13 | トピックメタが frontmatter のみ・本文なしになれば PASS |
| TC-exportAllData-008 | ドキュメントファイルの出力 | spec/testcases/export/exportAllData.md#L14 | frontmatter に sources（memoId/postedAt/日別ファイルへの相対 file パス）が載り、本文は最新リビジョンのみなら PASS |
| TC-exportAllData-009 | ソフトデリート済み出典の出力 | spec/testcases/export/exportAllData.md#L15 | 該当 source が memoId + deleted:true のみ（file/postedAt なし）で出力されれば PASS |
| TC-exportAllData-010 | ハードデリート済み出典の非出力 | spec/testcases/export/exportAllData.md#L16 | 該当出典が sources にエントリごと現れなければ PASS（ADR-003） |
| TC-exportAllData-011 | 完了済みトピックの包含 | spec/testcases/export/exportAllData.md#L17 | archived トピックもエクスポートされ frontmatter に archived:true が出れば PASS（ADR-002） |
| TC-exportAllData-012 | ゴミ箱・リビジョン履歴の除外 | spec/testcases/export/exportAllData.md#L18 | ゴミ箱内項目が現れず、各項目は最新リビジョンのみ・counts もゴミ箱除外なら PASS |
| TC-exportAllData-013 | ドキュメント0件トピック | spec/testcases/export/exportAllData.md#L19 | ドキュメント0件でも topics/{slug}/index.md が出力されれば PASS |
| TC-exportAllData-014 | 全データ0件の空アーカイブ | spec/testcases/export/exportAllData.md#L20 | counts 全0の index.md のみの zip が正常応答として返り、memos/・topics/ が出なければ PASS |
| TC-exportAllData-015 | メモ0件・トピックあり | spec/testcases/export/exportAllData.md#L21 | memos/ が出力されず topics/ は出力されれば PASS |
| TC-exportAllData-016 | スラッグの禁止文字除去 | spec/testcases/export/exportAllData.md#L22 | `/ \ : * ? " < > \| #` と制御文字が除去されたディレクトリ名になれば PASS |
| TC-exportAllData-017 | スラッグの正規化 | spec/testcases/export/exportAllData.md#L23 | NFC 正規化・前後空白除去・空白連続の `-` 1つ置換が行われれば PASS |
| TC-exportAllData-018 | スラッグ導出結果が空 | spec/testcases/export/exportAllData.md#L24 | スラッグが `untitled` になれば PASS |
| TC-exportAllData-019 | 先頭末尾の `.`/`-` 除去 | spec/testcases/export/exportAllData.md#L25 | スラッグ先頭・末尾の `.` と `-` が除去されれば PASS |
| TC-exportAllData-020 | 50コードポイント境界（許容） | spec/testcases/export/exportAllData.md#L26 | ちょうど50コードポイントの名前が切り詰めなしでスラッグになれば PASS |
| TC-exportAllData-021 | 51コードポイント以上の切り詰め | spec/testcases/export/exportAllData.md#L27 | サロゲートペア込みでコードポイント単位50文字に切り詰められれば PASS |
| TC-exportAllData-022 | 同名トピックのスラッグ衝突 | spec/testcases/export/exportAllData.md#L28 | createdAt 昇順で1件目は素のスラッグ・2件目以降 `-2`, `-3` … になれば PASS |
| TC-exportAllData-023 | 同一トピック内の同タイトル衝突 | spec/testcases/export/exportAllData.md#L29 | 同一階層でのみ連番が付き、別トピック配下の同名には付かなければ PASS |
| TC-exportAllData-024 | 切り詰め後・連番付与後の再衝突 | spec/testcases/export/exportAllData.md#L30 | 再衝突も同一規則で解決され ExportArchive.files の path が一意になれば PASS |
| TC-exportAllData-025 | 日本語スラッグ | spec/testcases/export/exportAllData.md#L31 | 非 ASCII 文字が除去されず日本語のままスラッグになれば PASS |
| TC-exportAllData-026 | ファイル順序とエンコーディング | spec/testcases/export/exportAllData.md#L32 | files が path 辞書順ソート・全ファイル UTF-8・改行 LF なら PASS |
| TC-exportAllData-027 | レンダリングの決定性 | spec/testcases/export/exportAllData.md#L33 | 同一データ・同一 exportedAt/timezone の2回実行がバイト同一なら PASS |
| TC-exportAllData-028 | timezone 空文字 | spec/testcases/export/exportAllData.md#L34 | BusinessRuleError(InvalidTimezone) となり ExportSourceReader が呼ばれなければ PASS |
| TC-exportAllData-029 | timezone 解決不能 | spec/testcases/export/exportAllData.md#L35 | IANA 解決不能な値で BusinessRuleError(InvalidTimezone) なら PASS |
| TC-exportAllData-030 | userId 形式不正 | spec/testcases/export/exportAllData.md#L36 | 値オブジェクト構築で ValidationError になれば PASS |
| TC-exportAllData-031 | 孤児ドキュメントの防衛検査 | spec/testcases/export/exportAllData.md#L37 | topics に不在の topicId を持つ不整合で BusinessRuleError(OrphanDocument)・zip 非生成なら PASS |
| TC-exportAllData-032 | ExportFile パス不変条件 | spec/testcases/export/exportAllData.md#L38 | 不正 path での構築が BusinessRuleError(InvalidArchivePath) になれば PASS |
| TC-exportAllData-033 | ExportArchive パス重複不変条件 | spec/testcases/export/exportAllData.md#L39 | path 重複での構築が BusinessRuleError(DuplicateArchivePath) になれば PASS |
| TC-exportAllData-034 | 読み取り DB 障害 | spec/testcases/export/exportAllData.md#L40 | SystemError(DatabaseError) となりレンダリング・zip 化が行われなければ PASS |
| TC-exportAllData-035 | zip エンコード失敗 | spec/testcases/export/exportAllData.md#L41 | SystemError(ArchiveEncodingError) になれば PASS |
| TC-exportAllData-036 | テナント分離 | spec/testcases/export/exportAllData.md#L42 | アーカイブに認証ユーザーのデータのみ含まれれば PASS |
| TC-exportAllData-037 | AI トークンから呼び出し不可 | spec/testcases/export/exportAllData.md#L43 | 公開インターフェースに含まれず AI から呼び出せなければ PASS（Web UI 専用） |
| TC-approveAiClientAuthorization-001 | 承認の正常系 | spec/testcases/identity/approveAiClientAuthorization.md#L9 | active な接続（lastUsedAt:null, version:0）が作成され connectionId 返却・aiClientConnected イベント記録なら PASS |
| TC-approveAiClientAuthorization-002 | クライアント名の trim | spec/testcases/identity/approveAiClientAuthorization.md#L10 | 前後空白付き名が trim 後の名前で接続作成されれば PASS |
| TC-approveAiClientAuthorization-003 | クライアント名100文字境界 | spec/testcases/identity/approveAiClientAuthorization.md#L11 | ちょうど100文字で正常に接続が作成されれば PASS |
| TC-approveAiClientAuthorization-004 | クライアント名101文字 | spec/testcases/identity/approveAiClientAuthorization.md#L12 | BusinessRuleError となり接続が作成されなければ PASS |
| TC-approveAiClientAuthorization-005 | クライアント名空・空白のみ | spec/testcases/identity/approveAiClientAuthorization.md#L13 | trim 後非空違反で BusinessRuleError・接続非作成なら PASS |
| TC-approveAiClientAuthorization-006 | 同名クライアントの再承認 | spec/testcases/identity/approveAiClientAuthorization.md#L14 | 新しい connectionId で別接続が作成されれば PASS（1回の許可＝1接続） |
| TC-approveAiClientAuthorization-007 | 失効後の再認可 | spec/testcases/identity/approveAiClientAuthorization.md#L15 | 新接続が作成され既存 revoked 接続が不変なら PASS |
| TC-approveAiClientAuthorization-008 | insert DB 例外 | spec/testcases/identity/approveAiClientAuthorization.md#L16 | SystemError・ロールバック・イベント未記録なら PASS |
| TC-changePassword-001 | 変更の正常系 | spec/testcases/identity/changePassword.md#L7 | passwordHash 置換・version+1・passwordChanged イベント記録で void 正常終了なら PASS |
| TC-changePassword-002 | 新パスワード8文字境界 | spec/testcases/identity/changePassword.md#L8 | ちょうど8文字で正常終了すれば PASS |
| TC-changePassword-003 | 新パスワード128文字境界 | spec/testcases/identity/changePassword.md#L9 | ちょうど128文字で正常終了すれば PASS |
| TC-changePassword-004 | 新パスワード7文字 | spec/testcases/identity/changePassword.md#L10 | BusinessRuleError(PasswordTooWeak)・パスワード不変なら PASS |
| TC-changePassword-005 | 新パスワード129文字 | spec/testcases/identity/changePassword.md#L11 | BusinessRuleError(PasswordTooWeak) なら PASS |
| TC-changePassword-006 | 現在パスワード不一致 | spec/testcases/identity/changePassword.md#L12 | ValidationError("CURRENT_PASSWORD_MISMATCH")・パスワード不変なら PASS |
| TC-changePassword-007 | 同一値への変更許容 | spec/testcases/identity/changePassword.md#L13 | 現在と同じ新パスワードでも正常終了すれば PASS |
| TC-changePassword-008 | ユーザー不在 | spec/testcases/identity/changePassword.md#L14 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-changePassword-009 | SsoUser への防衛的拒否 | spec/testcases/identity/changePassword.md#L15 | BusinessRuleError(PasswordNotSupported) なら PASS |
| TC-changePassword-010 | 二重変更の OCC 競合 | spec/testcases/identity/changePassword.md#L16 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-changePassword-011 | verify 計算失敗 | spec/testcases/identity/changePassword.md#L17 | SystemError なら PASS |
| TC-changePassword-012 | hash 失敗 | spec/testcases/identity/changePassword.md#L18 | SystemError なら PASS |
| TC-changePassword-013 | save DB 例外 | spec/testcases/identity/changePassword.md#L19 | SystemError・ロールバック・イベント未記録なら PASS |
| TC-changeTrashRetentionDays-001 | 変更の正常系 | spec/testcases/identity/changeTrashRetentionDays.md#L7 | trashRetentionDays 更新・version+1・trashRetentionChanged イベント記録で void なら PASS |
| TC-changeTrashRetentionDays-002 | 最小値1境界 | spec/testcases/identity/changeTrashRetentionDays.md#L8 | retentionDays:1 で正常更新されれば PASS |
| TC-changeTrashRetentionDays-003 | 0 指定 | spec/testcases/identity/changeTrashRetentionDays.md#L9 | BusinessRuleError(InvalidTrashRetentionDays)・設定不変なら PASS |
| TC-changeTrashRetentionDays-004 | 負数指定 | spec/testcases/identity/changeTrashRetentionDays.md#L10 | BusinessRuleError(InvalidTrashRetentionDays) なら PASS |
| TC-changeTrashRetentionDays-005 | 非整数指定 | spec/testcases/identity/changeTrashRetentionDays.md#L11 | 1.5 で BusinessRuleError(InvalidTrashRetentionDays) なら PASS |
| TC-changeTrashRetentionDays-006 | NaN / Infinity 指定 | spec/testcases/identity/changeTrashRetentionDays.md#L12 | BusinessRuleError(InvalidTrashRetentionDays) なら PASS |
| TC-changeTrashRetentionDays-007 | 同一値への変更許容 | spec/testcases/identity/changeTrashRetentionDays.md#L13 | 現在値と同じ指定でも正常終了すれば PASS |
| TC-changeTrashRetentionDays-008 | SsoUser でも変更可 | spec/testcases/identity/changeTrashRetentionDays.md#L14 | 認証方式に関わらず正常更新されれば PASS |
| TC-changeTrashRetentionDays-009 | 既存ゴミ箱項目への適用 | spec/testcases/identity/changeTrashRetentionDays.md#L15 | 変更後の値が既存・以後両方のゴミ箱項目の期限計算に適用されれば PASS |
| TC-changeTrashRetentionDays-010 | ユーザー不在 | spec/testcases/identity/changeTrashRetentionDays.md#L16 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-changeTrashRetentionDays-011 | OCC 競合 | spec/testcases/identity/changeTrashRetentionDays.md#L17 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-changeTrashRetentionDays-012 | save DB 例外 | spec/testcases/identity/changeTrashRetentionDays.md#L18 | SystemError・ロールバック・イベント未記録なら PASS |
| TC-denyAiClientAuthorization-001 | 拒否の正常系 | spec/testcases/identity/denyAiClientAuthorization.md#L9 | void 正常終了し、接続もイベントも作られなければ PASS |
| TC-denyAiClientAuthorization-002 | 拒否後の一覧非表示 | spec/testcases/identity/denyAiClientAuthorization.md#L10 | listAiClientConnections に拒否した認可の接続が現れなければ PASS |
| TC-denyAiClientAuthorization-003 | プロトコル拒否応答はアダプター責務 | spec/testcases/identity/denyAiClientAuthorization.md#L11 | アダプターがエラーリダイレクトを返す（ユースケース責務外）ことが確認できれば PASS |
| TC-executePasswordReset-001 | リセットの正常系 | spec/testcases/identity/executePasswordReset.md#L7 | トークン消費・passwordHash 置換・version+1・passwordChanged イベントで void なら PASS |
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
| TC-executePasswordReset-012 | SsoUser への防衛的拒否 | spec/testcases/identity/executePasswordReset.md#L18 | BusinessRuleError(PasswordNotSupported)・パスワード未設定なら PASS |
| TC-executePasswordReset-013 | OCC 競合 | spec/testcases/identity/executePasswordReset.md#L19 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-executePasswordReset-014 | hash 失敗 | spec/testcases/identity/executePasswordReset.md#L20 | SystemError なら PASS |
| TC-executePasswordReset-015 | トークンストア障害 | spec/testcases/identity/executePasswordReset.md#L21 | SystemError なら PASS |
| TC-executePasswordReset-016 | save DB 例外 | spec/testcases/identity/executePasswordReset.md#L22 | SystemError・ロールバック・イベント未記録なら PASS |
| TC-getCurrentUser-001 | PasswordUser の取得 | spec/testcases/identity/getCurrentUser.md#L7 | userId/email/authMethod:"password"/trashRetentionDays が返れば PASS |
| TC-getCurrentUser-002 | SsoUser の取得 | spec/testcases/identity/getCurrentUser.md#L8 | authMethod:"sso" が返れば PASS |
| TC-getCurrentUser-003 | 資格情報の非露出 | spec/testcases/identity/getCurrentUser.md#L9 | 出力 DTO に passwordHash 等が含まれなければ PASS |
| TC-getCurrentUser-004 | SSO 主体情報の非露出 | spec/testcases/identity/getCurrentUser.md#L10 | 出力 DTO に provider/providerSubject が含まれなければ PASS |
| TC-getCurrentUser-005 | 保持日数の既定値 | spec/testcases/identity/getCurrentUser.md#L11 | 登録直後は trashRetentionDays:30 が返れば PASS |
| TC-getCurrentUser-006 | 保持日数変更の反映 | spec/testcases/identity/getCurrentUser.md#L12 | 変更後の値（例:1）が返れば PASS |
| TC-getCurrentUser-007 | セッション有効・ユーザー不在 | spec/testcases/identity/getCurrentUser.md#L13 | NotFoundError("USER_NOT_FOUND") なら PASS |
| TC-getCurrentUser-008 | userId 空文字 | spec/testcases/identity/getCurrentUser.md#L14 | UserId 生成バリデーションで BusinessRuleError なら PASS |
| TC-getCurrentUser-009 | findById DB 例外 | spec/testcases/identity/getCurrentUser.md#L15 | SystemError なら PASS |
| TC-listAiClientConnections-001 | 一覧の正常系 | spec/testcases/identity/listAiClientConnections.md#L7 | 全接続が connectedAt 降順で返り、各要素に必要フィールドが含まれれば PASS |
| TC-listAiClientConnections-002 | 接続0件 | spec/testcases/identity/listAiClientConnections.md#L8 | 空配列が返れば PASS（エラーにしない） |
| TC-listAiClientConnections-003 | revoked 混在の一覧 | spec/testcases/identity/listAiClientConnections.md#L9 | 失効済み接続も status:"revoked"・revokedAt 非 null で含まれれば PASS |
| TC-listAiClientConnections-004 | 未使用接続の lastUsedAt | spec/testcases/identity/listAiClientConnections.md#L10 | 未使用接続の lastUsedAt が null なら PASS |
| TC-listAiClientConnections-005 | 利用済み接続の lastUsedAt | spec/testcases/identity/listAiClientConnections.md#L11 | recordUsage 済み接続に最終利用日時が入れば PASS |
| TC-listAiClientConnections-006 | テナント分離 | spec/testcases/identity/listAiClientConnections.md#L12 | 自ユーザーの接続のみ返れば PASS |
| TC-listAiClientConnections-007 | listByUserId DB 例外 | spec/testcases/identity/listAiClientConnections.md#L13 | SystemError なら PASS |
| TC-loginWithPassword-001 | ログインの正常系 | spec/testcases/identity/loginWithPassword.md#L7 | 正しい資格情報で userId が返れば PASS |
| TC-loginWithPassword-002 | メール正規化後の一致 | spec/testcases/identity/loginWithPassword.md#L8 | 大文字混在・前後空白付きメールでもログイン成功すれば PASS |
| TC-loginWithPassword-003 | 未登録メール | spec/testcases/identity/loginWithPassword.md#L9 | ValidationError("INVALID_CREDENTIALS") なら PASS |
| TC-loginWithPassword-004 | パスワード不一致 | spec/testcases/identity/loginWithPassword.md#L10 | ValidationError("INVALID_CREDENTIALS") なら PASS |
| TC-loginWithPassword-005 | SSO ユーザーへの試行 | spec/testcases/identity/loginWithPassword.md#L11 | ValidationError("INVALID_CREDENTIALS")（SSO であることを明かさない）なら PASS |
| TC-loginWithPassword-006 | メール形式不正の変換 | spec/testcases/identity/loginWithPassword.md#L12 | InvalidEmail ではなく ValidationError("INVALID_CREDENTIALS") に変換されれば PASS |
| TC-loginWithPassword-007 | 短いパスワードの変換 | spec/testcases/identity/loginWithPassword.md#L13 | PasswordTooWeak ではなく ValidationError("INVALID_CREDENTIALS") に変換されれば PASS |
| TC-loginWithPassword-008 | 失敗応答の同一性 | spec/testcases/identity/loginWithPassword.md#L14 | 各失敗ケースが同一エラー種別・メッセージで区別不能なら PASS |
| TC-loginWithPassword-009 | 8文字パスワードでの照合 | spec/testcases/identity/loginWithPassword.md#L15 | 最低長パスワードでログイン成功すれば PASS |
| TC-loginWithPassword-010 | findByEmail DB 例外 | spec/testcases/identity/loginWithPassword.md#L16 | SystemError なら PASS |
| TC-loginWithPassword-011 | verify 計算失敗 | spec/testcases/identity/loginWithPassword.md#L17 | SystemError（不一致の false と区別）なら PASS |
| TC-logout-001 | ログアウトの正常系 | spec/testcases/identity/logout.md#L9 | void 正常終了し、ドメイン状態変更・イベント・永続化が一切ないなら PASS |
| TC-logout-002 | セッション破棄は presentation 責務 | spec/testcases/identity/logout.md#L10 | presentation 層がセッションを破棄すれば PASS |
| TC-logout-003 | セッション破棄失敗 | spec/testcases/identity/logout.md#L11 | アダプター層で SystemError として扱われれば PASS |
| TC-registerOrLoginWithSso-001 | 初回 SSO 登録（Google） | spec/testcases/identity/registerOrLoginWithSso.md#L7 | SsoUser が version:0 で作成され userId と isNewUser:true・userRegistered イベントが出れば PASS |
| TC-registerOrLoginWithSso-002 | 初回 SSO 登録（Apple） | spec/testcases/identity/registerOrLoginWithSso.md#L8 | Apple プロバイダでも同様に登録されれば PASS |
| TC-registerOrLoginWithSso-003 | 2回目のログイン | spec/testcases/identity/registerOrLoginWithSso.md#L9 | 既存 userId と isNewUser:false が返り書き込み・イベントなしなら PASS |
| TC-registerOrLoginWithSso-004 | IdP メール変更時の主体優先 | spec/testcases/identity/registerOrLoginWithSso.md#L10 | SSO 主体一致が優先されログイン扱いになれば PASS |
| TC-registerOrLoginWithSso-005 | 未対応プロバイダ | spec/testcases/identity/registerOrLoginWithSso.md#L11 | BusinessRuleError(UnsupportedSsoProvider) なら PASS |
| TC-registerOrLoginWithSso-006 | IdP 由来メール形式不正 | spec/testcases/identity/registerOrLoginWithSso.md#L12 | BusinessRuleError(InvalidEmail) なら PASS |
| TC-registerOrLoginWithSso-007 | 既存 PasswordUser とのメール衝突 | spec/testcases/identity/registerOrLoginWithSso.md#L13 | ConflictError("EMAIL_ALREADY_REGISTERED")・自動リンクなしなら PASS |
| TC-registerOrLoginWithSso-008 | 別プロバイダ SsoUser とのメール衝突 | spec/testcases/identity/registerOrLoginWithSso.md#L14 | 認証方式をまたぐメール一意性で ConflictError("EMAIL_ALREADY_REGISTERED") なら PASS |
| TC-registerOrLoginWithSso-009 | 同時初回サインインのレース | spec/testcases/identity/registerOrLoginWithSso.md#L15 | 一意制約違反が捕捉され ConflictError("SSO_IDENTITY_ALREADY_REGISTERED") なら PASS |
| TC-registerOrLoginWithSso-010 | リポジトリ DB 例外 | spec/testcases/identity/registerOrLoginWithSso.md#L16 | SystemError・ロールバックなら PASS |
| TC-registerWithPassword-001 | 登録の正常系 | spec/testcases/identity/registerWithPassword.md#L7 | PasswordUser が version:0 で作成され userId 返却・userRegistered イベントが同一 TX で Outbox に記録されれば PASS |
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
| TC-registerWithPassword-012 | SsoUser とのメール重複 | spec/testcases/identity/registerWithPassword.md#L18 | ConflictError("EMAIL_ALREADY_REGISTERED")・自動リンクなしなら PASS |
| TC-registerWithPassword-013 | 正規化後一致の重複検出 | spec/testcases/identity/registerWithPassword.md#L19 | 大文字/小文字表記違いでも重複検出されれば PASS |
| TC-registerWithPassword-014 | 同時登録レース | spec/testcases/identity/registerWithPassword.md#L20 | email 一意制約違反が捕捉され ConflictError("EMAIL_ALREADY_REGISTERED") なら PASS |
| TC-registerWithPassword-015 | hash 失敗 | spec/testcases/identity/registerWithPassword.md#L21 | SystemError・ユーザー非作成なら PASS |
| TC-registerWithPassword-016 | insert DB 例外 | spec/testcases/identity/registerWithPassword.md#L22 | SystemError・ロールバック・イベント未記録なら PASS |
| TC-requestPasswordReset-001 | 依頼の正常系 | spec/testcases/identity/requestPasswordReset.md#L7 | トークン発行とリセットメール送信が行われ void 正常終了なら PASS |
| TC-requestPasswordReset-002 | 未登録メールの黙殺 | spec/testcases/identity/requestPasswordReset.md#L8 | 発行・送信なしで登録済みと同一の正常応答なら PASS |
| TC-requestPasswordReset-003 | SsoUser メールの黙殺 | spec/testcases/identity/requestPasswordReset.md#L9 | 発行・送信なしで未登録と同一の正常応答なら PASS |
| TC-requestPasswordReset-004 | 応答の同一性 | spec/testcases/identity/requestPasswordReset.md#L10 | 登録済み/未登録/SSO の応答が同一で区別不能なら PASS |
| TC-requestPasswordReset-005 | メール形式不正 | spec/testcases/identity/requestPasswordReset.md#L11 | BusinessRuleError(InvalidEmail) なら PASS |
| TC-requestPasswordReset-006 | 正規化後一致での発行 | spec/testcases/identity/requestPasswordReset.md#L12 | 大文字混在メールでもトークン発行・送信されれば PASS |
| TC-requestPasswordReset-007 | トークン発行障害 | spec/testcases/identity/requestPasswordReset.md#L13 | SystemError なら PASS |
| TC-requestPasswordReset-008 | メール送信障害 | spec/testcases/identity/requestPasswordReset.md#L14 | SystemError なら PASS |
| TC-requestPasswordReset-009 | findByEmail DB 例外 | spec/testcases/identity/requestPasswordReset.md#L15 | SystemError なら PASS |
| TC-requestPasswordReset-010 | 連続依頼 | spec/testcases/identity/requestPasswordReset.md#L16 | 依頼ごとにトークンが発行され毎回正常終了すれば PASS |
| TC-revokeAiClientConnection-001 | 失効の正常系 | spec/testcases/identity/revokeAiClientConnection.md#L7 | revoked へ遷移・version+1・aiClientRevoked イベント記録で void なら PASS |
| TC-revokeAiClientConnection-002 | 失効イベントでのトークン削除 | spec/testcases/identity/revokeAiClientConnection.md#L8 | consumer が実トークンを削除し以後の API 呼び出しが認可エラーになれば PASS |
| TC-revokeAiClientConnection-003 | 接続不在 | spec/testcases/identity/revokeAiClientConnection.md#L9 | NotFoundError("CONNECTION_NOT_FOUND") なら PASS |
| TC-revokeAiClientConnection-004 | 他ユーザー接続の指定 | spec/testcases/identity/revokeAiClientConnection.md#L10 | 不在と区別しない NotFoundError となり相手の接続が不変なら PASS |
| TC-revokeAiClientConnection-005 | connectionId 空文字 | spec/testcases/identity/revokeAiClientConnection.md#L11 | ID 生成バリデーションで BusinessRuleError なら PASS |
| TC-revokeAiClientConnection-006 | 再失効の冪等性 | spec/testcases/identity/revokeAiClientConnection.md#L12 | 変更・version 進行・イベント再発行なしで正常終了すれば PASS |
| TC-revokeAiClientConnection-007 | 同時失効の OCC 競合 | spec/testcases/identity/revokeAiClientConnection.md#L13 | 先勝ち成功・後発 ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-revokeAiClientConnection-008 | 失効の不可逆性 | spec/testcases/identity/revokeAiClientConnection.md#L14 | 再有効化不可で新しい認可フローが必要なことが確認できれば PASS |
| TC-revokeAiClientConnection-009 | save DB 例外 | spec/testcases/identity/revokeAiClientConnection.md#L15 | SystemError・ロールバック・接続 active のままなら PASS |
| TC-createDocument-001 | 作成の正常系 | spec/testcases/knowledge/createDocument.md#L7 | ActiveDocument・リビジョン#1・SourceLink 2件が同一 UoW で保存され document.created が記録されれば PASS |
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
| TC-createDocument-016 | 他ユーザートピックへの作成 | spec/testcases/knowledge/createDocument.md#L22 | userId スコープにより NotFoundError なら PASS |
| TC-createDocument-017 | 出典の一部不在で全体失敗 | spec/testcases/knowledge/createDocument.md#L23 | NotFoundError で全体失敗しドキュメント・リビジョン・リンクとも非作成なら PASS |
| TC-createDocument-018 | 出典の一部がゴミ箱内 | spec/testcases/knowledge/createDocument.md#L24 | listActiveByIds に含まれず NotFoundError で全体失敗すれば PASS |
| TC-createDocument-019 | 出典の一部が他ユーザー所有 | spec/testcases/knowledge/createDocument.md#L25 | 区別なしの NotFoundError で全体失敗すれば PASS |
| TC-createDocument-020 | 出典 ID に空文字 | spec/testcases/knowledge/createDocument.md#L26 | MemoId 構築違反で BusinessRuleError なら PASS |
| TC-createDocument-021 | トピック touch と trashTopic の競合 | spec/testcases/knowledge/createDocument.md#L27 | touch が 0 行更新で ConflictError となり trashed トピック配下に active ドキュメントが生まれなければ PASS |
| TC-createDocument-022 | トピック touch と updateTopic の競合 | spec/testcases/knowledge/createDocument.md#L28 | 同様に ConflictError となり非作成なら PASS |
| TC-createDocument-023 | touch の副作用範囲 | spec/testcases/knowledge/createDocument.md#L29 | トピックの version のみ進み内容不変・トピックイベントなしなら PASS |
| TC-createDocument-024 | AI 経由の作成 | spec/testcases/knowledge/createDocument.md#L30 | MCP create_document が人間 UI と同一の振る舞いになれば PASS |
| TC-createDocument-025 | insertSourceLinks DB 例外 | spec/testcases/knowledge/createDocument.md#L31 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-createTopic-001 | 作成の正常系 | spec/testcases/knowledge/createTopic.md#L7 | active/version:0 のトピックとビュー返却・topic.created が同一 UoW で記録されれば PASS |
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
| TC-createTopic-014 | insert DB 例外 | spec/testcases/knowledge/createTopic.md#L20 | SystemError(DatabaseError)・ロールバック・イベント未記録なら PASS |
| TC-diffDocumentRevisions-001 | 二点取得の正常系 | spec/testcases/knowledge/diffDocumentRevisions.md#L7 | base/target に当時の全文スナップショットとメタデータが返り差分計算はされなければ PASS |
| TC-diffDocumentRevisions-002 | 新→旧の順指定 | spec/testcases/knowledge/diffDocumentRevisions.md#L8 | 順序制約なく指定どおり返れば PASS |
| TC-diffDocumentRevisions-003 | 隣接二点・最小構成 | spec/testcases/knowledge/diffDocumentRevisions.md#L9 | リビジョン番号 1 を含む二点が正常に返れば PASS |
| TC-diffDocumentRevisions-004 | ゴミ箱内ドキュメントの二点取得 | spec/testcases/knowledge/diffDocumentRevisions.md#L10 | リビジョンが引ければ返る（人間 UI の履歴閲覧経路）なら PASS |
| TC-diffDocumentRevisions-005 | 同一番号の二点指定 | spec/testcases/knowledge/diffDocumentRevisions.md#L11 | ValidationError なら PASS |
| TC-diffDocumentRevisions-006 | 存在しないリビジョン番号 | spec/testcases/knowledge/diffDocumentRevisions.md#L12 | 一方でも不在なら NotFoundError で PASS |
| TC-diffDocumentRevisions-007 | ドキュメント不在 | spec/testcases/knowledge/diffDocumentRevisions.md#L13 | NotFoundError なら PASS |
| TC-diffDocumentRevisions-008 | 他ユーザー所有 | spec/testcases/knowledge/diffDocumentRevisions.md#L14 | userId スコープで NotFoundError なら PASS |
| TC-diffDocumentRevisions-009 | revisionNumber 0 | spec/testcases/knowledge/diffDocumentRevisions.md#L15 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffDocumentRevisions-010 | revisionNumber 非整数 | spec/testcases/knowledge/diffDocumentRevisions.md#L16 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffDocumentRevisions-011 | documentId 空文字 | spec/testcases/knowledge/diffDocumentRevisions.md#L17 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-diffDocumentRevisions-012 | findRevision DB 例外 | spec/testcases/knowledge/diffDocumentRevisions.md#L18 | SystemError(DatabaseError) なら PASS |
| TC-editDocument-001 | 編集保存の正常系 | spec/testcases/knowledge/editDocument.md#L7 | result:"saved"・新リビジョン（人間 actor・指定理由）・version+1・document.edited 記録なら PASS |
| TC-editDocument-002 | changeReason 省略時の既定値 | spec/testcases/knowledge/editDocument.md#L8 | 「手動編集」が補完されれば PASS |
| TC-editDocument-003 | changeReason 空白のみ | spec/testcases/knowledge/editDocument.md#L9 | 「手動編集」補完で result:"saved" なら PASS |
| TC-editDocument-004 | 同一内容の保存 | spec/testcases/knowledge/editDocument.md#L10 | result:"unchanged" でリビジョン・save・イベントなしなら PASS |
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
| TC-editDocument-016 | 他ユーザー所有 | spec/testcases/knowledge/editDocument.md#L22 | userId スコープで NotFoundError なら PASS |
| TC-editDocument-017 | documentId 空文字 | spec/testcases/knowledge/editDocument.md#L23 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-editDocument-018 | save 直前の割り込み競合 | spec/testcases/knowledge/editDocument.md#L24 | 0 行更新または一意制約違反で ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-editDocument-019 | insertRevision DB 例外 | spec/testcases/knowledge/editDocument.md#L25 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-editDocumentByAi-001 | patch 適用の正常系 | spec/testcases/knowledge/editDocumentByAi.md#L7 | 置換後本文で changed:true・AI actor の新リビジョン・document.edited 記録なら PASS |
| TC-editDocumentByAi-002 | mode 省略時の既定 | spec/testcases/knowledge/editDocumentByAi.md#L8 | 既定モード patch として適用されれば PASS |
| TC-editDocumentByAi-003 | hunks の逐次適用 | spec/testcases/knowledge/editDocumentByAi.md#L9 | 配列順に前の置換結果へ順次マッチして適用されれば PASS |
| TC-editDocumentByAi-004 | newText 空文字による削除 | spec/testcases/knowledge/editDocumentByAi.md#L10 | 該当箇所の削除として適用されれば PASS |
| TC-editDocumentByAi-005 | replaceAll の正常系 | spec/testcases/knowledge/editDocumentByAi.md#L11 | 受領全文で新リビジョンが積まれタイトルは維持されれば PASS |
| TC-editDocumentByAi-006 | 空本文への replaceAll | spec/testcases/knowledge/editDocumentByAi.md#L12 | 空本文ドキュメントが replaceAll で正常編集されれば PASS |
| TC-editDocumentByAi-007 | 空本文への patch | spec/testcases/knowledge/editDocumentByAi.md#L13 | BusinessRuleError(PatchTargetNotFound) なら PASS |
| TC-editDocumentByAi-008 | replaceAll で空本文へ | spec/testcases/knowledge/editDocumentByAi.md#L14 | body:"" への置換が正常受理され新リビジョンが積まれれば PASS |
| TC-editDocumentByAi-009 | 同一結果の編集 | spec/testcases/knowledge/editDocumentByAi.md#L15 | changed:false でリビジョン・イベントなしなら PASS |
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
| TC-editDocumentByAi-023 | 他ユーザー所有 | spec/testcases/knowledge/editDocumentByAi.md#L29 | userId スコープで NotFoundError なら PASS |
| TC-editDocumentByAi-024 | documentId 空文字 | spec/testcases/knowledge/editDocumentByAi.md#L30 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-editDocumentByAi-025 | 人間編集との競合 | spec/testcases/knowledge/editDocumentByAi.md#L31 | 0 行更新または一意制約違反で ConflictError なら PASS |
| TC-editDocumentByAi-026 | save DB 例外 | spec/testcases/knowledge/editDocumentByAi.md#L32 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-getDocument-001 | 取得の正常系 | spec/testcases/knowledge/getDocument.md#L7 | id/topicId/title/body/latestRevision/version/日時が返れば PASS |
| TC-getDocument-002 | 空本文の取得 | spec/testcases/knowledge/getDocument.md#L8 | body:"" で正常に返れば PASS |
| TC-getDocument-003 | 出典一覧の非包含 | spec/testcases/knowledge/getDocument.md#L9 | 出典メモ一覧が含まれなければ PASS（listDocumentSourceMemos の責務） |
| TC-getDocument-004 | ドキュメント不在 | spec/testcases/knowledge/getDocument.md#L10 | NotFoundError なら PASS |
| TC-getDocument-005 | ゴミ箱内の非取得 | spec/testcases/knowledge/getDocument.md#L11 | findById が active のみ返し NotFoundError なら PASS |
| TC-getDocument-006 | 他ユーザー所有 | spec/testcases/knowledge/getDocument.md#L12 | userId スコープで NotFoundError（存在の有無も漏らさない）なら PASS |
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
| TC-getTopic-012 | 他ユーザー所有 | spec/testcases/knowledge/getTopic.md#L18 | userId スコープで NotFoundError なら PASS |
| TC-getTopic-013 | topicId 空文字 | spec/testcases/knowledge/getTopic.md#L19 | BusinessRuleError(InvalidTopicId) なら PASS |
| TC-getTopic-014 | メモ一括取得 DB 例外 | spec/testcases/knowledge/getTopic.md#L20 | SystemError(DatabaseError) なら PASS |
| TC-listDocumentRevisions-001 | 履歴一覧の正常系 | spec/testcases/knowledge/listDocumentRevisions.md#L7 | revisionNumber 昇順のメタデータのみ（全文なし）と latestRevision が返れば PASS |
| TC-listDocumentRevisions-002 | AI 編集リビジョンの actor | spec/testcases/knowledge/listDocumentRevisions.md#L8 | actor が { kind:"aiClient", clientName } で返れば PASS |
| TC-listDocumentRevisions-003 | 初版のみの履歴 | spec/testcases/knowledge/listDocumentRevisions.md#L9 | 1 件のみ返れば PASS（存在すれば必ず 1 件以上） |
| TC-listDocumentRevisions-004 | ゴミ箱内ドキュメントの履歴 | spec/testcases/knowledge/listDocumentRevisions.md#L10 | findByIdIncludingTrashed で正常に履歴が返れば PASS |
| TC-listDocumentRevisions-005 | ドキュメント不在 | spec/testcases/knowledge/listDocumentRevisions.md#L11 | NotFoundError なら PASS（ハードデリートは履歴ごと消える） |
| TC-listDocumentRevisions-006 | 他ユーザー所有 | spec/testcases/knowledge/listDocumentRevisions.md#L12 | userId スコープで NotFoundError なら PASS |
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
| TC-listDocumentSourceMemos-010 | 他ユーザー所有 | spec/testcases/knowledge/listDocumentSourceMemos.md#L16 | userId スコープで NotFoundError なら PASS |
| TC-listDocumentSourceMemos-011 | documentId 空文字 | spec/testcases/knowledge/listDocumentSourceMemos.md#L17 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-listDocumentSourceMemos-012 | メモ一括取得 DB 例外 | spec/testcases/knowledge/listDocumentSourceMemos.md#L18 | SystemError(DatabaseError) なら PASS |
| TC-listDocumentsReferencingMemo-001 | 参照元一覧の正常系 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L7 | documentId/title/topicId/deleted:false/linkedAt を持つ 2 件が返れば PASS |
| TC-listDocumentsReferencingMemo-002 | ソフトデリート済み参照元の表示 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L8 | deleted:true として一覧に残れば PASS |
| TC-listDocumentsReferencingMemo-003 | ハードデリート済み参照元の非表示 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L9 | 一覧に現れなければ PASS（ADR-003） |
| TC-listDocumentsReferencingMemo-004 | 参照 0 件 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L10 | documents:[] で返れば PASS |
| TC-listDocumentsReferencingMemo-005 | 一括取得（N+1 回避） | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L11 | listByIdsIncludingTrashed の 1 クエリで取得されれば PASS |
| TC-listDocumentsReferencingMemo-006 | メモ自身がソフトデリート済み | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L12 | findByIdIncludingTrashed で正常に返れば PASS |
| TC-listDocumentsReferencingMemo-007 | メモ不在 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L13 | NotFoundError なら PASS |
| TC-listDocumentsReferencingMemo-008 | 他ユーザー所有 | spec/testcases/knowledge/listDocumentsReferencingMemo.md#L14 | userId スコープで NotFoundError なら PASS |
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
| TC-rollbackDocument-001 | ロールバックの正常系 | spec/testcases/knowledge/rollbackDocument.md#L7 | 対象と同内容の新リビジョンが積まれ既存履歴は残り changed:true・document.edited 記録なら PASS |
| TC-rollbackDocument-002 | changeReason 省略時の既定値 | spec/testcases/knowledge/rollbackDocument.md#L8 | 「リビジョンNの内容に戻す」が補完されれば PASS |
| TC-rollbackDocument-003 | changeReason 空白のみ | spec/testcases/knowledge/rollbackDocument.md#L9 | 既定値補完で正常にロールバックされれば PASS |
| TC-rollbackDocument-004 | 同一内容への戻し | spec/testcases/knowledge/rollbackDocument.md#L10 | changed:false でリビジョン・イベントなしなら PASS |
| TC-rollbackDocument-005 | 最新自身への戻し | spec/testcases/knowledge/rollbackDocument.md#L11 | changed:false なら PASS |
| TC-rollbackDocument-006 | 初版のみで初版へ戻し | spec/testcases/knowledge/rollbackDocument.md#L12 | changed:false なら PASS |
| TC-rollbackDocument-007 | AI 編集後の人間による復元 | spec/testcases/knowledge/rollbackDocument.md#L13 | 新リビジョンの actor が人間ユーザーとして記録されれば PASS |
| TC-rollbackDocument-008 | 存在しないリビジョン番号 | spec/testcases/knowledge/rollbackDocument.md#L14 | NotFoundError なら PASS |
| TC-rollbackDocument-009 | revisionNumber 0 | spec/testcases/knowledge/rollbackDocument.md#L15 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-rollbackDocument-010 | revisionNumber 非整数・負数 | spec/testcases/knowledge/rollbackDocument.md#L16 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-rollbackDocument-011 | changeReason 不正 | spec/testcases/knowledge/rollbackDocument.md#L17 | 改行入り/201文字が対応する BusinessRuleError になれば PASS |
| TC-rollbackDocument-012 | ドキュメント不在 | spec/testcases/knowledge/rollbackDocument.md#L18 | NotFoundError なら PASS |
| TC-rollbackDocument-013 | ゴミ箱内ドキュメント | spec/testcases/knowledge/rollbackDocument.md#L19 | NotFoundError なら PASS |
| TC-rollbackDocument-014 | 他ユーザー所有 | spec/testcases/knowledge/rollbackDocument.md#L20 | userId スコープで NotFoundError なら PASS |
| TC-rollbackDocument-015 | 別ドキュメントのリビジョン防衛線 | spec/testcases/knowledge/rollbackDocument.md#L21 | BusinessRuleError(RevisionDocumentMismatch) なら PASS |
| TC-rollbackDocument-016 | 並行編集との競合 | spec/testcases/knowledge/rollbackDocument.md#L22 | 0 行更新または一意制約違反で ConflictError なら PASS |
| TC-rollbackDocument-017 | insertRevision DB 例外 | spec/testcases/knowledge/rollbackDocument.md#L23 | SystemError(DatabaseError)・UoW 全体ロールバックなら PASS |
| TC-trashDocument-001 | 個別削除の正常系 | spec/testcases/knowledge/trashDocument.md#L7 | trashed/trashedAt:now/trashedWith:null・version+1・document.trashed 記録なら PASS |
| TC-trashDocument-002 | 個別削除分はセット復元対象外 | spec/testcases/knowledge/trashDocument.md#L8 | セット復元後も trashedWith:null の項目がゴミ箱に残れば PASS |
| TC-trashDocument-003 | リンク・履歴の保持 | spec/testcases/knowledge/trashDocument.md#L9 | 出典リンク・リビジョンが消えなければ PASS（可逆） |
| TC-trashDocument-004 | ドキュメント不在 | spec/testcases/knowledge/trashDocument.md#L10 | NotFoundError なら PASS |
| TC-trashDocument-005 | 二重削除 | spec/testcases/knowledge/trashDocument.md#L11 | 既に trashed のドキュメントへの再削除が NotFoundError になれば PASS |
| TC-trashDocument-006 | 他ユーザー所有 | spec/testcases/knowledge/trashDocument.md#L12 | userId スコープで NotFoundError なら PASS |
| TC-trashDocument-007 | documentId 空文字 | spec/testcases/knowledge/trashDocument.md#L13 | BusinessRuleError(InvalidDocumentId) なら PASS |
| TC-trashDocument-008 | 並行操作との競合 | spec/testcases/knowledge/trashDocument.md#L14 | save 0 行更新で ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-trashDocument-009 | AI 経由の削除 | spec/testcases/knowledge/trashDocument.md#L15 | MCP delete(type:"document") が人間 UI と同一の振る舞いになれば PASS |
| TC-trashDocument-010 | save DB 例外 | spec/testcases/knowledge/trashDocument.md#L16 | SystemError(DatabaseError)・ロールバック・イベント未記録なら PASS |
| TC-trashTopic-001 | セット削除の正常系 | spec/testcases/knowledge/trashTopic.md#L7 | トピック trashed + 配下が trashedWith=topic.id で trashed になり topic.trashed + document.trashed×2 が記録されれば PASS |
| TC-trashTopic-002 | archived トピックの削除 | spec/testcases/knowledge/trashTopic.md#L8 | wasArchived:true で trashed になれば PASS |
| TC-trashTopic-003 | 配下 0 件のセット削除 | spec/testcases/knowledge/trashTopic.md#L9 | トピックのみ trashed・trashedDocumentIds:[]・document.trashed なしなら PASS |
| TC-trashTopic-004 | 個別削除済み配下の非対象 | spec/testcases/knowledge/trashTopic.md#L10 | trashedWith:null の項目は変更されず active のみセット対象になれば PASS |
| TC-trashTopic-005 | trashedWith の一致 | spec/testcases/knowledge/trashTopic.md#L11 | セット削除された全配下の trashedWith が topic.id と一致すれば PASS |
| TC-trashTopic-006 | トピック不在 | spec/testcases/knowledge/trashTopic.md#L12 | NotFoundError なら PASS |
| TC-trashTopic-007 | 二重削除 | spec/testcases/knowledge/trashTopic.md#L13 | 既に trashed のトピックへの再削除が NotFoundError になれば PASS |
| TC-trashTopic-008 | 他ユーザー所有 | spec/testcases/knowledge/trashTopic.md#L14 | userId スコープで NotFoundError なら PASS |
| TC-trashTopic-009 | topicId 空文字 | spec/testcases/knowledge/trashTopic.md#L15 | BusinessRuleError(InvalidTopicId) なら PASS |
| TC-trashTopic-010 | トピック save の競合 | spec/testcases/knowledge/trashTopic.md#L16 | 0 行更新で ConflictError となりトピック・ドキュメントとも不変なら PASS |
| TC-trashTopic-011 | 配下ドキュメント save の競合 | spec/testcases/knowledge/trashTopic.md#L17 | ConflictError で UoW 全体ロールバック・部分セット削除が残らなければ PASS |
| TC-trashTopic-012 | AI 経由の削除 | spec/testcases/knowledge/trashTopic.md#L18 | MCP delete(type:"topic") が人間 UI と同一のセット削除になれば PASS |
| TC-trashTopic-013 | save DB 例外 | spec/testcases/knowledge/trashTopic.md#L19 | SystemError(DatabaseError)・ロールバック・イベント未記録なら PASS |
| TC-updateTopic-001 | rename の正常系 | spec/testcases/knowledge/updateTopic.md#L7 | 名前変更・version+1・topic.updated 記録・status 不変なら PASS |
| TC-updateTopic-002 | description 変更 | spec/testcases/knowledge/updateTopic.md#L8 | 説明文変更・version+1・topic.updated 記録なら PASS |
| TC-updateTopic-003 | description null 明示指定 | spec/testcases/knowledge/updateTopic.md#L9 | 説明文が削除され null になれば PASS（省略との区別） |
| TC-updateTopic-004 | アーカイブ遷移 | spec/testcases/knowledge/updateTopic.md#L10 | archived へ遷移し topic.archived 記録なら PASS |
| TC-updateTopic-005 | アーカイブ解除 | spec/testcases/knowledge/updateTopic.md#L11 | active へ遷移し topic.unarchived 記録なら PASS |
| TC-updateTopic-006 | 状態往復 | spec/testcases/knowledge/updateTopic.md#L12 | archive→unarchive の往復が成立し version 2 回・各イベント 1 件なら PASS |
| TC-updateTopic-007 | active への冪等指定 | spec/testcases/knowledge/updateTopic.md#L13 | 同状態指定でイベントなし・version のみ規約どおり進めば PASS |
| TC-updateTopic-008 | archived への冪等指定 | spec/testcases/knowledge/updateTopic.md#L14 | 同状態指定でイベントが発行されなければ PASS |
| TC-updateTopic-009 | rename + archive 同時指定 | spec/testcases/knowledge/updateTopic.md#L15 | 順に適用され topic.updated と topic.archived 両方が記録されれば PASS |
| TC-updateTopic-010 | archived トピックの rename | spec/testcases/knowledge/updateTopic.md#L16 | rename 成功・archived 維持なら PASS |
| TC-updateTopic-011 | 全フィールド省略 | spec/testcases/knowledge/updateTopic.md#L17 | presentation 層スキーマで ValidationError なら PASS |
| TC-updateTopic-012 | トピック不在 | spec/testcases/knowledge/updateTopic.md#L18 | NotFoundError なら PASS |
| TC-updateTopic-013 | ゴミ箱内トピック | spec/testcases/knowledge/updateTopic.md#L19 | NotFoundError なら PASS（ゴミ箱内は編集不可） |
| TC-updateTopic-014 | 他ユーザー所有 | spec/testcases/knowledge/updateTopic.md#L20 | userId スコープで NotFoundError なら PASS |
| TC-updateTopic-015 | topicId 空文字 | spec/testcases/knowledge/updateTopic.md#L21 | BusinessRuleError(InvalidTopicId) なら PASS |
| TC-updateTopic-016 | name 不正各種 | spec/testcases/knowledge/updateTopic.md#L22 | 空/改行入り/101文字が対応する BusinessRuleError・トピック不変なら PASS |
| TC-updateTopic-017 | name 100文字境界 | spec/testcases/knowledge/updateTopic.md#L23 | 正常更新されれば PASS |
| TC-updateTopic-018 | description 不正 | spec/testcases/knowledge/updateTopic.md#L24 | 空文字/501文字が対応する BusinessRuleError になれば PASS |
| TC-updateTopic-019 | description 500文字境界 | spec/testcases/knowledge/updateTopic.md#L25 | 正常更新されれば PASS |
| TC-updateTopic-020 | 並行更新の競合 | spec/testcases/knowledge/updateTopic.md#L26 | save 0 行更新で ConflictError・変更未保存なら PASS |
| TC-updateTopic-021 | AI 経由のアーカイブ切替 | spec/testcases/knowledge/updateTopic.md#L27 | MCP update_topic が人間 UI と同一の振る舞いになれば PASS |
| TC-updateTopic-022 | save DB 例外 | spec/testcases/knowledge/updateTopic.md#L28 | SystemError(DatabaseError)・ロールバック・イベント未記録なら PASS |
| TC-delete-001 | AI 削除の正常系 | spec/testcases/memo/delete.md#L7 | type:"memo" 指定でメモが trashed/trashedAt:now になり void が返れば PASS（ハードデリート API なし） |
| TC-delete-002 | memo.trashed イベント | spec/testcases/memo/delete.md#L8 | 同一 UoW で Outbox に記録されれば PASS |
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
| TC-diffMemoRevisions-001 | 二点取得の正常系 | spec/testcases/memo/diffMemoRevisions.md#L7 | base/target の RevisionView（全文スナップショット含む）が返り差分計算はされなければ PASS |
| TC-diffMemoRevisions-002 | 逆順指定 | spec/testcases/memo/diffMemoRevisions.md#L8 | 指定どおりの base/target で返れば PASS |
| TC-diffMemoRevisions-003 | AI 編集リビジョンの actor | spec/testcases/memo/diffMemoRevisions.md#L9 | actor が { kind:"aiClient", clientName } で返れば PASS |
| TC-diffMemoRevisions-004 | 最小の二点 | spec/testcases/memo/diffMemoRevisions.md#L10 | 番号 1 を含む二点が正常に返れば PASS |
| TC-diffMemoRevisions-005 | trashed メモの二点取得 | spec/testcases/memo/diffMemoRevisions.md#L11 | ゴミ箱内メモでも正常に返れば PASS |
| TC-diffMemoRevisions-006 | 同一番号の二点指定 | spec/testcases/memo/diffMemoRevisions.md#L12 | ValidationError なら PASS |
| TC-diffMemoRevisions-007 | 存在しない番号 | spec/testcases/memo/diffMemoRevisions.md#L13 | NotFoundError なら PASS |
| TC-diffMemoRevisions-008 | メモ不在 | spec/testcases/memo/diffMemoRevisions.md#L14 | NotFoundError なら PASS |
| TC-diffMemoRevisions-009 | 他ユーザー所有 | spec/testcases/memo/diffMemoRevisions.md#L15 | userId スコープで NotFoundError なら PASS |
| TC-diffMemoRevisions-010 | baseRevisionNumber 0 | spec/testcases/memo/diffMemoRevisions.md#L16 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffMemoRevisions-011 | 負数・非整数 | spec/testcases/memo/diffMemoRevisions.md#L17 | BusinessRuleError(InvalidRevisionNumber) なら PASS |
| TC-diffMemoRevisions-012 | memoId 空文字 | spec/testcases/memo/diffMemoRevisions.md#L18 | バリデーションエラーなら PASS |
| TC-diffMemoRevisions-013 | AI トークンからの到達不可 | spec/testcases/memo/diffMemoRevisions.md#L19 | 公開範囲・スコープで構造的に排除されれば PASS |
| TC-diffMemoRevisions-014 | DB 例外 | spec/testcases/memo/diffMemoRevisions.md#L20 | SystemError(DatabaseError) なら PASS |
| TC-editMemo-001 | 編集保存の正常系 | spec/testcases/memo/editMemo.md#L7 | result:"saved" で新本文・version:1・latestRevisionNumber:2 の MemoView が返れば PASS |
| TC-editMemo-002 | 新リビジョンとイベント | spec/testcases/memo/editMemo.md#L8 | 全文スナップショットの新リビジョンと memo.edited が同一 UoW で記録されれば PASS |
| TC-editMemo-003 | postedAt 不変 | spec/testcases/memo/editMemo.md#L9 | postedAt 不変・updatedAt が now に更新されれば PASS |
| TC-editMemo-004 | 同一本文の no-op | spec/testcases/memo/editMemo.md#L10 | result:"unchanged" でリビジョン・version・イベントなしなら PASS |
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
| TC-postMemo-003 | memo.created イベント | spec/testcases/memo/postMemo.md#L9 | memoId のみのペイロードで同一 UoW の Outbox に記録されれば PASS |
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
| TC-post_memo-003 | memo.created イベント | spec/testcases/memo/post_memo.md#L9 | 同一 UoW で Outbox に記録されれば PASS |
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
| TC-rollbackMemo-002 | 新リビジョンとイベント | spec/testcases/memo/rollbackMemo.md#L8 | 新リビジョン記録・memo.edited・version+1・postedAt 不変なら PASS |
| TC-rollbackMemo-003 | 同一内容の no-op | spec/testcases/memo/rollbackMemo.md#L9 | result:"unchanged" でリビジョン・イベントなしなら PASS |
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
| TC-softDeleteMemo-002 | memo.trashed イベント | spec/testcases/memo/softDeleteMemo.md#L8 | memoId のみのペイロードで同一 UoW の Outbox に記録されれば PASS |
| TC-softDeleteMemo-003 | タイムラインからの消失 | spec/testcases/memo/softDeleteMemo.md#L9 | getTimeline に含まれなければ PASS |
| TC-softDeleteMemo-004 | データ保持（可逆） | spec/testcases/memo/softDeleteMemo.md#L10 | 本文・全リビジョン・postedAt が保持されれば PASS |
| TC-softDeleteMemo-005 | 出典リンクの保持 | spec/testcases/memo/softDeleteMemo.md#L11 | リンクが残り参照元で「削除済みのメモ」表示になれば PASS |
| TC-softDeleteMemo-006 | メモ不在 | spec/testcases/memo/softDeleteMemo.md#L12 | NotFoundError なら PASS |
| TC-softDeleteMemo-007 | 二重削除 | spec/testcases/memo/softDeleteMemo.md#L13 | NotFoundError（不在と同じ扱い）なら PASS |
| TC-softDeleteMemo-008 | 他ユーザー所有 | spec/testcases/memo/softDeleteMemo.md#L14 | NotFoundError なら PASS |
| TC-softDeleteMemo-009 | memoId 空文字 | spec/testcases/memo/softDeleteMemo.md#L15 | バリデーションエラーなら PASS |
| TC-softDeleteMemo-010 | 割り込み書き込みの競合 | spec/testcases/memo/softDeleteMemo.md#L16 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-softDeleteMemo-011 | save DB 例外 | spec/testcases/memo/softDeleteMemo.md#L17 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-update_memo-001 | AI 全文更新の正常系 | spec/testcases/memo/update_memo.md#L7 | result:"saved" で新本文・latestRevisionNumber:2（全文置換のみ・パッチ非対応）なら PASS |
| TC-update_memo-002 | AI actor のリビジョンとイベント | spec/testcases/memo/update_memo.md#L8 | AI actor の新リビジョンと memo.edited が同一 UoW で記録されれば PASS |
| TC-update_memo-003 | postedAt 不変 | spec/testcases/memo/update_memo.md#L9 | postedAt が変わらなければ PASS |
| TC-update_memo-004 | 同一本文の no-op | spec/testcases/memo/update_memo.md#L10 | result:"unchanged" でリビジョン・version・イベントなしなら PASS |
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
| TC-maintainSearchIndex-001 | memo.created の upsert | spec/testcases/search/maintainSearchIndex.md#L7 | 最新状態を読み直して upsertMemo し、成功後に markProcessed → ack されれば PASS |
| TC-maintainSearchIndex-002 | memo.edited は最新本文で upsert | spec/testcases/search/maintainSearchIndex.md#L8 | ペイロードでなく読み直した最新本文で upsert されれば PASS（巻き戻り防止） |
| TC-maintainSearchIndex-003 | memo.restored のファンアウト | spec/testcases/search/maintainSearchIndex.md#L9 | upsertMemo に加え逆引きした出典先ドキュメントが各 upsertDocument されれば PASS |
| TC-maintainSearchIndex-004 | memo.trashed の除去とファンアウト | spec/testcases/search/maintainSearchIndex.md#L10 | removeMemo に加え相手ドキュメントの sourceMemoIds から ID が外れれば PASS |
| TC-maintainSearchIndex-005 | memo.hardDeleted は remove のみ | spec/testcases/search/maintainSearchIndex.md#L11 | removeMemo のみでファンアウトしなければ PASS（リンク側は sourceLinksChanged が担う） |
| TC-maintainSearchIndex-006 | memo.sourceLinksChanged の再構築 | spec/testcases/search/maintainSearchIndex.md#L12 | 読み直しで sourceOfDocumentIds に active な相手のみ反映されれば PASS |
| TC-maintainSearchIndex-007 | document.created の upsert とファンアウト | spec/testcases/search/maintainSearchIndex.md#L13 | upsertDocument に加え出典メモが各 upsertMemo されれば PASS |
| TC-maintainSearchIndex-008 | document.edited の upsert | spec/testcases/search/maintainSearchIndex.md#L14 | 最新状態を読み直して upsertDocument されれば PASS |
| TC-maintainSearchIndex-009 | document.restored のファンアウト | spec/testcases/search/maintainSearchIndex.md#L15 | upsertDocument に加え出典メモが再 upsertMemo されれば PASS |
| TC-maintainSearchIndex-010 | document.trashed の除去とファンアウト | spec/testcases/search/maintainSearchIndex.md#L16 | removeDocument に加え相手メモの sourceOfDocumentIds から ID が外れれば PASS |
| TC-maintainSearchIndex-011 | document.hardDeleted は remove のみ | spec/testcases/search/maintainSearchIndex.md#L17 | removeDocument のみでファンアウトしなければ PASS |
| TC-maintainSearchIndex-012 | document.sourceLinksChanged の再構築 | spec/testcases/search/maintainSearchIndex.md#L18 | 読み直しで sourceMemoIds に active な相手のみ反映されれば PASS |
| TC-maintainSearchIndex-013 | メモエントリの相手 ID フィルタ | spec/testcases/search/maintainSearchIndex.md#L19 | sourceOfDocumentIds に active な相手のみ含まれれば PASS |
| TC-maintainSearchIndex-014 | ドキュメントエントリの相手 ID フィルタ | spec/testcases/search/maintainSearchIndex.md#L20 | sourceMemoIds に active な出典のみ含まれれば PASS |
| TC-maintainSearchIndex-015 | topic.created/updated の no-op | spec/testcases/search/maintainSearchIndex.md#L21 | インデックス操作なしで markProcessed → ack されれば PASS |
| TC-maintainSearchIndex-016 | topic.trashed/restored の no-op | spec/testcases/search/maintainSearchIndex.md#L22 | no-op で ack されれば PASS（カスケードは document イベントで受ける） |
| TC-maintainSearchIndex-017 | topic.archived/unarchived の no-op | spec/testcases/search/maintainSearchIndex.md#L23 | no-op で ack され配下のインデックスが不変なら PASS |
| TC-maintainSearchIndex-018 | 未知イベント種別の no-op | spec/testcases/search/maintainSearchIndex.md#L24 | quarantine に落とさず no-op で ack されれば PASS |
| TC-maintainSearchIndex-019 | 重複配信のスキップ | spec/testcases/search/maintainSearchIndex.md#L25 | 処理済み eventId がスキップされインデックス操作なしで ack されれば PASS |
| TC-maintainSearchIndex-020 | markProcessed 前クラッシュ後の再実行 | spec/testcases/search/maintainSearchIndex.md#L26 | 冪等な再実行で最終状態不変・成功後に markProcessed されれば PASS |
| TC-maintainSearchIndex-021 | 逆順到達の remove 正規化 | spec/testcases/search/maintainSearchIndex.md#L27 | trashed 済み対象への遅延 created が removeMemo に正規化され収束すれば PASS |
| TC-maintainSearchIndex-022 | 対象不在の remove 正規化 | spec/testcases/search/maintainSearchIndex.md#L28 | ハードデリート済み対象への upsert 契機がエラーにならず remove に正規化されれば PASS |
| TC-maintainSearchIndex-023 | 不在 ID への remove の冪等性 | spec/testcases/search/maintainSearchIndex.md#L29 | 存在しない ID の remove が冪等に成功し ack されれば PASS |
| TC-maintainSearchIndex-024 | ファンアウト途中失敗の再試行 | spec/testcases/search/maintainSearchIndex.md#L30 | markProcessed せず throw して再配信に乗り、再実行で全体成功後に stamp されれば PASS |
| TC-maintainSearchIndex-025 | インデックスストア障害 | spec/testcases/search/maintainSearchIndex.md#L31 | SystemError(SearchIndexUnavailable) を throw し markProcessed されず、再配信で回復すれば PASS |
| TC-maintainSearchIndex-026 | 埋め込み生成失敗 | spec/testcases/search/maintainSearchIndex.md#L32 | SystemError(EmbeddingFailed) を throw し再配信で回復すれば PASS |
| TC-maintainSearchIndex-027 | 壊れたペイロードの隔離 | spec/testcases/search/maintainSearchIndex.md#L33 | デコード失敗がリトライ後 maxAttempts で quarantine されれば PASS |
| TC-maintainSearchIndex-028 | 並行配信の収束 | spec/testcases/search/maintainSearchIndex.md#L34 | スキップまたは冪等再実行のいずれかに落ち最終状態が最新に収束すれば PASS |
| TC-search-001 | 検索の正常系 | spec/testcases/search/search.md#L7 | メモ/ドキュメント項目が所定フィールド付き PaginationResult で返り count が総件数なら PASS |
| TC-search-002 | topicName の一括解決 | spec/testcases/search/search.md#L8 | listByIds 1 回で全ヒットに topicName が付与されれば PASS（N+1 回避） |
| TC-search-003 | メモ項目の sourceOfDocumentIds | spec/testcases/search/search.md#L9 | active な出典先ドキュメント ID が含まれれば PASS |
| TC-search-004 | ドキュメント項目の sourceMemoIds | spec/testcases/search/search.md#L10 | active な出典メモ ID が含まれれば PASS |
| TC-search-005 | リンクなし項目の空配列 | spec/testcases/search/search.md#L11 | sourceOfDocumentIds/sourceMemoIds が空配列（null でない）なら PASS |
| TC-search-006 | キーワード・ベクトル結果の統合 | spec/testcases/search/search.md#L12 | 同一 type+id が 1 件に統合され重複しなければ PASS |
| TC-search-007 | snippet は原文抜粋 | spec/testcases/search/search.md#L13 | 非空の原文抜粋で全文・要約・言い換えでなければ PASS |
| TC-search-008 | topicId 絞り込み | spec/testcases/search/search.md#L14 | トピック配下ドキュメントとその出典メモのみに絞られれば PASS |
| TC-search-009 | トピック内一致なし | spec/testcases/search/search.md#L15 | items:[] の空結果でエラーにならなければ PASS |
| TC-search-010 | アーカイブ済みトピックのヒット | spec/testcases/search/search.md#L16 | アーカイブ配下のドキュメント・出典メモがヒットすれば PASS |
| TC-search-011 | ゴミ箱内項目の非ヒット | spec/testcases/search/search.md#L17 | ソフトデリート済み項目がヒットしなければ PASS |
| TC-search-012 | ゴミ箱内ドキュメント ID の非露出 | spec/testcases/search/search.md#L18 | メモ項目の sourceOfDocumentIds に含まれなければ PASS |
| TC-search-013 | ゴミ箱内メモ ID の非露出 | spec/testcases/search/search.md#L19 | ドキュメント項目の sourceMemoIds に含まれなければ PASS |
| TC-search-014 | テナント分離 | spec/testcases/search/search.md#L20 | 他ユーザーのデータにのみ一致があっても結果が空なら PASS |
| TC-search-015 | 一致なしキーワード | spec/testcases/search/search.md#L21 | items:[]・count:0 の空結果が返れば PASS |
| TC-search-016 | キーワードの trim | spec/testcases/search/search.md#L22 | trim 後のキーワードで正常検索されれば PASS |
| TC-search-017 | キーワード500文字境界 | spec/testcases/search/search.md#L23 | trim 後ちょうど500文字で正常検索されれば PASS |
| TC-search-018 | ページング | spec/testcases/search/search.md#L24 | ページごとに関連度順で重複なく返り count が一定なら PASS |
| TC-search-019 | limit 下限境界 | spec/testcases/search/search.md#L25 | limit:1 で 1 件・count は総件数なら PASS |
| TC-search-020 | limit 上限境界 | spec/testcases/search/search.md#L26 | limit:100 で正常検索されれば PASS |
| TC-search-021 | 範囲外ページ | spec/testcases/search/search.md#L27 | items:[] の空ページと正しい count が返れば PASS |
| TC-search-022 | インデックス遅延の許容 | spec/testcases/search/search.md#L28 | 書き込み直後の非ヒットがエラーでなくその時点の結果として返れば PASS（ADR-005） |
| TC-search-023 | キーワード空文字 | spec/testcases/search/search.md#L29 | BusinessRuleError(EmptyKeyword)・検索未実行なら PASS |
| TC-search-024 | キーワード空白のみ | spec/testcases/search/search.md#L30 | BusinessRuleError(EmptyKeyword) なら PASS |
| TC-search-025 | キーワード501文字 | spec/testcases/search/search.md#L31 | BusinessRuleError(KeywordTooLong) なら PASS |
| TC-search-026 | userId 形式不正 | spec/testcases/search/search.md#L32 | 値オブジェクト構築エラーで query が呼ばれなければ PASS |
| TC-search-027 | topicId 形式不正 | spec/testcases/search/search.md#L33 | バリデーションエラーで query が呼ばれなければ PASS |
| TC-search-028 | page 0 | spec/testcases/search/search.md#L34 | Pagination 構築エラーなら PASS |
| TC-search-029 | page 非整数 | spec/testcases/search/search.md#L35 | Pagination 構築エラーなら PASS |
| TC-search-030 | limit 0 | spec/testcases/search/search.md#L36 | Pagination 構築エラーなら PASS |
| TC-search-031 | limit 101 | spec/testcases/search/search.md#L37 | Pagination 構築エラーなら PASS |
| TC-search-032 | インデックスストア障害 | spec/testcases/search/search.md#L38 | SystemError(SearchIndexUnavailable)（retryable）が返れば PASS |
| TC-emptyTrash-001 | 全消去の正常系 | spec/testcases/trash/emptyTrash.md#L7 | 全項目が hardDeleteTrashItem と同一手順で消去され deletedCount が返れば PASS |
| TC-emptyTrash-002 | セット展開の重複除去 | spec/testcases/trash/emptyTrash.md#L8 | 展開と単独項目の二重出現が和集合で除去され各対象が一度だけ消去されれば PASS |
| TC-emptyTrash-003 | ページ送りでの全件取得 | spec/testcases/trash/emptyTrash.md#L9 | ページサイズ超の項目もページ送りで全件消去されれば PASS |
| TC-emptyTrash-004 | 出典リンクの同期消去 | spec/testcases/trash/emptyTrash.md#L10 | 同一 UoW でリンク消去・document.sourceLinksChanged 発行なら PASS（ADR-003） |
| TC-emptyTrash-005 | 空のゴミ箱 | spec/testcases/trash/emptyTrash.md#L11 | エラーにせず deletedCount:0 なら PASS |
| TC-emptyTrash-006 | 並行消去済み項目の no-op | spec/testcases/trash/emptyTrash.md#L12 | 再取得で不在の項目を no-op として続行すれば PASS |
| TC-emptyTrash-007 | OCC 競合項目のスキップ続行 | spec/testcases/trash/emptyTrash.md#L13 | 失敗を記録して次項目へ進み全体が中断しなければ PASS |
| TC-emptyTrash-008 | 再実行の冪等性 | spec/testcases/trash/emptyTrash.md#L14 | 消去済みは現れず残件のみ消去されれば PASS |
| TC-emptyTrash-009 | 項目ごとの UoW 分離 | spec/testcases/trash/emptyTrash.md#L15 | 失敗項目のみロールバックされ成功分は確定していれば PASS |
| TC-emptyTrash-010 | テナント分離 | spec/testcases/trash/emptyTrash.md#L16 | 他ユーザーの項目が対象にならなければ PASS |
| TC-emptyTrash-011 | ユーザー不在 | spec/testcases/trash/emptyTrash.md#L17 | NotFoundError なら PASS |
| TC-emptyTrash-012 | listTrashItems DB 例外 | spec/testcases/trash/emptyTrash.md#L18 | SystemError(DatabaseError) なら PASS |
| TC-hardDeleteTrashItem-001 | 出典でないメモの消去 | spec/testcases/trash/hardDeleteTrashItem.md#L7 | 本体と全リビジョンが消え memo.hardDeleted のみ収集されれば PASS |
| TC-hardDeleteTrashItem-002 | 出典メモの消去とリンク同期消去 | spec/testcases/trash/hardDeleteTrashItem.md#L8 | 同一 UoW でリンク消去・memo.hardDeleted + 影響先への document.sourceLinksChanged 収集なら PASS（ADR-003） |
| TC-hardDeleteTrashItem-003 | ドキュメント消去 | spec/testcases/trash/hardDeleteTrashItem.md#L9 | 全リビジョン・リンクが同一バッチで消え document.hardDeleted + memo.sourceLinksChanged 収集なら PASS |
| TC-hardDeleteTrashItem-004 | セット配下単独の消去 | spec/testcases/trash/hardDeleteTrashItem.md#L10 | 当該ドキュメントのみ消えトピック・他配下に波及しなければ PASS |
| TC-hardDeleteTrashItem-005 | トピックのセット展開消去 | spec/testcases/trash/hardDeleteTrashItem.md#L11 | expandTargets で配下 2 件も展開され document.hardDeleted×2 + topic.hardDeleted なら PASS |
| TC-hardDeleteTrashItem-006 | 展開配下の出典リンク処理 | spec/testcases/trash/hardDeleteTrashItem.md#L12 | 各配下の出典確定と memo.sourceLinksChanged 発行があれば PASS |
| TC-hardDeleteTrashItem-007 | 個別削除分の非対象 | spec/testcases/trash/hardDeleteTrashItem.md#L13 | trashedWith:null の項目は setDocumentIds に含まれず残れば PASS |
| TC-hardDeleteTrashItem-008 | 配下なしトピック | spec/testcases/trash/hardDeleteTrashItem.md#L14 | documentIds:[] に展開されトピックのみ消去されれば PASS |
| TC-hardDeleteTrashItem-009 | 出典全滅ドキュメントの無影響 | spec/testcases/trash/hardDeleteTrashItem.md#L15 | 出典一覧が空になってもドキュメント内容に影響しなければ PASS |
| TC-hardDeleteTrashItem-010 | 期限内の明示消去 | spec/testcases/trash/hardDeleteTrashItem.md#L16 | expiresAt 直前でもユーザー明示操作として消去されれば PASS |
| TC-hardDeleteTrashItem-011 | 並行消去済み対象の no-op | spec/testcases/trash/hardDeleteTrashItem.md#L17 | 不在対象を no-op として残りを消去すれば PASS |
| TC-hardDeleteTrashItem-012 | kind 列挙外 | spec/testcases/trash/hardDeleteTrashItem.md#L18 | バリデーションエラーなら PASS |
| TC-hardDeleteTrashItem-013 | id 空文字 | spec/testcases/trash/hardDeleteTrashItem.md#L19 | バリデーションエラーなら PASS |
| TC-hardDeleteTrashItem-014 | ユーザー不在 | spec/testcases/trash/hardDeleteTrashItem.md#L20 | NotFoundError なら PASS |
| TC-hardDeleteTrashItem-015 | 項目不在 | spec/testcases/trash/hardDeleteTrashItem.md#L21 | NotFoundError なら PASS |
| TC-hardDeleteTrashItem-016 | ゴミ箱外項目の指定 | spec/testcases/trash/hardDeleteTrashItem.md#L22 | NotFoundError なら PASS（直接ハードデリート経路は存在しない） |
| TC-hardDeleteTrashItem-017 | 他ユーザー所有 | spec/testcases/trash/hardDeleteTrashItem.md#L23 | NotFoundError なら PASS |
| TC-hardDeleteTrashItem-018 | 並行復元との競合 | spec/testcases/trash/hardDeleteTrashItem.md#L24 | ConflictError で UoW ロールバック・リンク消去とイベントも取り消されれば PASS |
| TC-hardDeleteTrashItem-019 | リポジトリ DB 例外 | spec/testcases/trash/hardDeleteTrashItem.md#L25 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-listTrash-001 | 横断一覧の正常系 | spec/testcases/trash/listTrash.md#L7 | 3 種別横断の TrashItemView[] が削除日時降順で返り trashedAt/expiresAt 付与なら PASS |
| TC-listTrash-002 | メモ項目のフィールド | spec/testcases/trash/listTrash.md#L8 | excerpt を含み他種別フィールドを含まなければ PASS |
| TC-listTrash-003 | 個別削除ドキュメント項目 | spec/testcases/trash/listTrash.md#L9 | title・topicId 付きで deletedWithTopic:false なら PASS |
| TC-listTrash-004 | セット削除の識別 | spec/testcases/trash/listTrash.md#L10 | topic 項目に name/setDocumentIds、配下は deletedWithTopic:true なら PASS |
| TC-listTrash-005 | セット分と個別分の区別 | spec/testcases/trash/listTrash.md#L11 | setDocumentIds はセット分のみ・個別分は deletedWithTopic:false で独立に並べば PASS |
| TC-listTrash-006 | ページング | spec/testcases/trash/listTrash.md#L12 | page:2/limit:10 で 11〜20 件目と正しいメタが返れば PASS |
| TC-listTrash-007 | 範囲外ページ | spec/testcases/trash/listTrash.md#L13 | items 空配列・totalCount 維持でエラーにならなければ PASS |
| TC-listTrash-008 | 空のゴミ箱 | spec/testcases/trash/listTrash.md#L14 | items:[]・totalCount:0 なら PASS |
| TC-listTrash-009 | 既定保持日数での期限算出 | spec/testcases/trash/listTrash.md#L15 | expiresAt = trashedAt + 30日 なら PASS |
| TC-listTrash-010 | 保持日数短縮の遡及適用 | spec/testcases/trash/listTrash.md#L16 | 既存項目も trashedAt + 7日 で照会時算出されれば PASS |
| TC-listTrash-011 | 保持日数延長の遡及適用 | spec/testcases/trash/listTrash.md#L17 | 既存項目も trashedAt + 60日 で算出されれば PASS |
| TC-listTrash-012 | 最小保持日数 | spec/testcases/trash/listTrash.md#L18 | retentionDays:1 で expiresAt > trashedAt を満たせば PASS |
| TC-listTrash-013 | テナント分離 | spec/testcases/trash/listTrash.md#L19 | 他ユーザーの項目が一切含まれなければ PASS |
| TC-listTrash-014 | page 0 | spec/testcases/trash/listTrash.md#L20 | バリデーションエラーなら PASS |
| TC-listTrash-015 | page 非整数 | spec/testcases/trash/listTrash.md#L21 | バリデーションエラーなら PASS |
| TC-listTrash-016 | limit 0 | spec/testcases/trash/listTrash.md#L22 | バリデーションエラーなら PASS |
| TC-listTrash-017 | limit 101 | spec/testcases/trash/listTrash.md#L23 | バリデーションエラーなら PASS |
| TC-listTrash-018 | limit 境界（正常） | spec/testcases/trash/listTrash.md#L24 | limit:1/100 で正常処理されれば PASS |
| TC-listTrash-019 | ユーザー不在 | spec/testcases/trash/listTrash.md#L25 | NotFoundError なら PASS |
| TC-listTrash-020 | listTrashItems DB 例外 | spec/testcases/trash/listTrash.md#L26 | SystemError(DatabaseError) なら PASS |
| TC-pruneExpiredTrashItems-001 | 期限切れ消去の正常系 | spec/testcases/trash/pruneExpiredTrashItems.md#L7 | 各項目が展開され項目ごとの UoW で消去手順が実行され processedCount が返れば PASS |
| TC-pruneExpiredTrashItems-002 | 出典メモのリンク同期消去 | spec/testcases/trash/pruneExpiredTrashItems.md#L8 | 同一 UoW でリンク消去・memo.hardDeleted + document.sourceLinksChanged 収集なら PASS |
| TC-pruneExpiredTrashItems-003 | セット削除トピックの展開 | spec/testcases/trash/pruneExpiredTrashItems.md#L9 | 追加照会なしで setDocumentIds から展開され配下ごと消去されれば PASS |
| TC-pruneExpiredTrashItems-004 | 配下ドキュメント単独の期限切れ | spec/testcases/trash/pruneExpiredTrashItems.md#L10 | 単品ハードデリートとして消去されれば PASS |
| TC-pruneExpiredTrashItems-005 | expiresAt == now の非対象 | spec/testcases/trash/pruneExpiredTrashItems.md#L11 | 厳密な `<` 判定で消去されなければ PASS |
| TC-pruneExpiredTrashItems-006 | 1ms 過去の対象化 | spec/testcases/trash/pruneExpiredTrashItems.md#L12 | 期限切れとして消去されれば PASS |
| TC-pruneExpiredTrashItems-007 | 期限内項目への不干渉 | spec/testcases/trash/pruneExpiredTrashItems.md#L13 | listExpiredItems が空・processedCount:0 で一切触れなければ PASS |
| TC-pruneExpiredTrashItems-008 | 短縮の遡及適用 | spec/testcases/trash/pruneExpiredTrashItems.md#L14 | 新保持日数で判定され既存項目も消去されれば PASS |
| TC-pruneExpiredTrashItems-009 | 延長の遡及適用 | spec/testcases/trash/pruneExpiredTrashItems.md#L15 | 期限内と判定され消去されなければ PASS |
| TC-pruneExpiredTrashItems-010 | ユーザー横断の抽出 | spec/testcases/trash/pruneExpiredTrashItems.md#L16 | 各ユーザーの保持日数を適用して抽出・userId スコープで消去されれば PASS |
| TC-pruneExpiredTrashItems-011 | batchSize での打ち切り | spec/testcases/trash/pruneExpiredTrashItems.md#L17 | 1 実行 batchSize 件までで残りを次回に委ねれば PASS |
| TC-pruneExpiredTrashItems-012 | 再実行の冪等性 | spec/testcases/trash/pruneExpiredTrashItems.md#L18 | 消去済みは現れず processedCount:0 なら PASS |
| TC-pruneExpiredTrashItems-013 | 並行消去済みの no-op | spec/testcases/trash/pruneExpiredTrashItems.md#L19 | 行不在の対象を no-op として続行すれば PASS |
| TC-pruneExpiredTrashItems-014 | OCC 競合の先送り | spec/testcases/trash/pruneExpiredTrashItems.md#L20 | 記録して次項目へ進み failedCount に計上されれば PASS |
| TC-pruneExpiredTrashItems-015 | 項目ごとの UoW 分離 | spec/testcases/trash/pruneExpiredTrashItems.md#L21 | 失敗項目のみロールバックされ他は確定していれば PASS |
| TC-pruneExpiredTrashItems-016 | listExpiredItems DB 例外 | spec/testcases/trash/pruneExpiredTrashItems.md#L22 | SystemError(DatabaseError) で実行終了し次回に委ねれば PASS |
| TC-pruneExpiredTrashItems-017 | batchSize 不正 | spec/testcases/trash/pruneExpiredTrashItems.md#L23 | 0 または非整数でバリデーションエラーなら PASS |
| TC-restoreDocument-001 | restoreAlone の正常系 | spec/testcases/trash/restoreDocument.md#L9 | トピック touch → restore → save が同一 UoW で行われ restored/restoredTopicId:null・document.restored 収集なら PASS |
| TC-restoreDocument-002 | archived トピックへの単独復元 | spec/testcases/trash/restoreDocument.md#L10 | archived も存命扱いで restoreAlone になれば PASS |
| TC-restoreDocument-003 | 復元による「削除済み」表示の解消 | spec/testcases/trash/restoreDocument.md#L11 | リンク保持のため追加操作なしで表示が解消されれば PASS |
| TC-restoreDocument-004 | 再取得でトピック trashed 化 | spec/testcases/trash/restoreDocument.md#L12 | 書き込まず setRestoreConfirmationRequired を返せば PASS |
| TC-restoreDocument-005 | 再取得でトピックハードデリート化 | spec/testcases/trash/restoreDocument.md#L13 | 書き込まず destinationSelectionRequired を返せば PASS |
| TC-restoreDocument-006 | touch と並行操作の競合 | spec/testcases/trash/restoreDocument.md#L14 | touch 0 行更新で ConflictError となりドキュメント未復元なら PASS |
| TC-restoreDocument-007 | 再取得でドキュメント不在/active | spec/testcases/trash/restoreDocument.md#L15 | NotFoundError なら PASS |
| TC-restoreDocument-008 | セット復元の確認要求 | spec/testcases/trash/restoreDocument.md#L21 | confirmSetRestore なしで書き込みゼロ・setRestoreConfirmationRequired と topicId/topicName が返れば PASS |
| TC-restoreDocument-009 | confirmSetRestore:true のセット復元 | spec/testcases/trash/restoreDocument.md#L22 | restoreTopicSet でトピック+配下全件が同一 UoW で復元されイベント収集されれば PASS |
| TC-restoreDocument-010 | wasArchived トピックのセット復元 | spec/testcases/trash/restoreDocument.md#L23 | トピックが archived 状態へ戻りセット復元も実行されれば PASS |
| TC-restoreDocument-011 | 個別削除分の要求対象の必須復元 | spec/testcases/trash/restoreDocument.md#L24 | skippedDocuments 分類でも要求対象は追加 restore で必ず復元されれば PASS |
| TC-restoreDocument-012 | 他の個別削除分の残置 | spec/testcases/trash/restoreDocument.md#L25 | 要求対象以外の skippedDocuments はゴミ箱に残れば PASS |
| TC-restoreDocument-013 | 確認中にトピック復元済み | spec/testcases/trash/restoreDocument.md#L26 | 現況再判定で restoreAlone 相当として処理されれば PASS |
| TC-restoreDocument-014 | 確認中にトピックハードデリート | spec/testcases/trash/restoreDocument.md#L27 | 再判定で destinationSelectionRequired を返せば PASS |
| TC-restoreDocument-015 | listTrashedByTopic 不整合の防衛 | spec/testcases/trash/restoreDocument.md#L28 | BusinessRuleError(TrashedWithMismatch) なら PASS |
| TC-restoreDocument-016 | セット復元の OCC 競合 | spec/testcases/trash/restoreDocument.md#L29 | ConflictError で UoW 全体ロールバックなら PASS |
| TC-restoreDocument-017 | 復元先選択の要求 | spec/testcases/trash/restoreDocument.md#L35 | destination 省略時に書き込みゼロで destinationSelectionRequired を返せば PASS |
| TC-restoreDocument-018 | 既存トピックへの復元 | spec/testcases/trash/restoreDocument.md#L36 | touch → moveToTopic（trashedWith null 化）→ restore が同一 UoW で行われ restoredTopicId が返れば PASS |
| TC-restoreDocument-019 | 新規トピックへの復元 | spec/testcases/trash/restoreDocument.md#L37 | 新規トピック作成後に移動・復元され topic.created + document.restored 収集なら PASS |
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
| TC-restoreDocument-032 | pruner 等との並行競合 | spec/testcases/trash/restoreDocument.md#L55 | ConflictError("OPTIMISTIC_LOCK_FAILURE") なら PASS |
| TC-restoreDocument-033 | DB 例外 | spec/testcases/trash/restoreDocument.md#L56 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-restoreMemo-001 | 復元の正常系 | spec/testcases/trash/restoreMemo.md#L7 | ActiveMemo へ遷移・保存され memoId 返却・memo.restored 収集なら PASS |
| TC-restoreMemo-002 | 元の位置への復帰 | spec/testcases/trash/restoreMemo.md#L8 | postedAt 不変でタイムラインの元の位置に戻れば PASS |
| TC-restoreMemo-003 | 出典メモの復元 | spec/testcases/trash/restoreMemo.md#L9 | リンク保持のまま復元され memo.restored が再インデックスの契機になれば PASS |
| TC-restoreMemo-004 | 期限間近の復元可能性 | spec/testcases/trash/restoreMemo.md#L10 | 期限内なら通常どおり復元されれば PASS |
| TC-restoreMemo-005 | memoId 空文字 | spec/testcases/trash/restoreMemo.md#L11 | バリデーションエラーなら PASS |
| TC-restoreMemo-006 | メモ不在 | spec/testcases/trash/restoreMemo.md#L12 | NotFoundError なら PASS |
| TC-restoreMemo-007 | active メモの復元要求 | spec/testcases/trash/restoreMemo.md#L13 | NotFoundError なら PASS |
| TC-restoreMemo-008 | 他ユーザー所有 | spec/testcases/trash/restoreMemo.md#L14 | userId スコープで NotFoundError なら PASS |
| TC-restoreMemo-009 | ハードデリート済み | spec/testcases/trash/restoreMemo.md#L15 | NotFoundError なら PASS |
| TC-restoreMemo-010 | 並行操作との競合 | spec/testcases/trash/restoreMemo.md#L16 | ConflictError・ロールバック・イベント未発行なら PASS |
| TC-restoreMemo-011 | リポジトリ DB 例外 | spec/testcases/trash/restoreMemo.md#L17 | SystemError(DatabaseError)・ロールバックなら PASS |
| TC-restoreTopic-001 | セット復元の正常系 | spec/testcases/trash/restoreTopic.md#L7 | トピックと配下 2 件が同一 UoW で復元され restoredDocumentIds・topic.restored + document.restored×2 収集なら PASS |
| TC-restoreTopic-002 | active への復帰 | spec/testcases/trash/restoreTopic.md#L8 | wasArchived:false のトピックが active に戻れば PASS |
| TC-restoreTopic-003 | archived への復帰 | spec/testcases/trash/restoreTopic.md#L9 | wasArchived:true のトピックが archived に戻れば PASS |
| TC-restoreTopic-004 | 配下 0 件のセット復元 | spec/testcases/trash/restoreTopic.md#L10 | トピックのみ復元・restoredDocumentIds:[]・topic.restored のみなら PASS |
| TC-restoreTopic-005 | 個別削除分の残置 | spec/testcases/trash/restoreTopic.md#L11 | セット分のみ復元され trashedWith:null 分はゴミ箱に残れば PASS |
| TC-restoreTopic-006 | 期限間近の復元可能性 | spec/testcases/trash/restoreTopic.md#L12 | 期限内なら通常どおりセット復元されれば PASS |
| TC-restoreTopic-007 | topicId 空文字 | spec/testcases/trash/restoreTopic.md#L13 | バリデーションエラーなら PASS |
| TC-restoreTopic-008 | トピック不在 | spec/testcases/trash/restoreTopic.md#L14 | NotFoundError なら PASS |
| TC-restoreTopic-009 | active/archived トピックの復元要求 | spec/testcases/trash/restoreTopic.md#L15 | ゴミ箱にないため NotFoundError なら PASS |
| TC-restoreTopic-010 | 他ユーザー所有 | spec/testcases/trash/restoreTopic.md#L16 | NotFoundError なら PASS |
| TC-restoreTopic-011 | listTrashedByTopic 不整合の防衛 | spec/testcases/trash/restoreTopic.md#L17 | BusinessRuleError(TrashedWithMismatch) なら PASS |
| TC-restoreTopic-012 | 並行操作との競合 | spec/testcases/trash/restoreTopic.md#L18 | ConflictError で UoW 全体ロールバック・部分復元なしなら PASS |
| TC-restoreTopic-013 | リポジトリ DB 例外 | spec/testcases/trash/restoreTopic.md#L19 | SystemError(DatabaseError)・ロールバックなら PASS |
