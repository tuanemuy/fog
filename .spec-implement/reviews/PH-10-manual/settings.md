# settings.md 実走結果（PH-10）
- 実行: 2026-09-11T12:29+09:00〜13:05+09:00、環境 dev :3000、HEAD `87a1f46`〜`1210ec5`（途中の修正は topics / documents / search / trash / 保持期限フォーム / dialog の CSS）、agent-browser session ph10-settings。実行者: Implementer
- テストアカウント（手順書の値 → 実際に使った値）: テストユーザー → `ph10-settings-main@example.com` / `password123`、TC-11 の新規ユーザー → `ph10-settings-empty@example.com` / `password123`
- 事前データ（`ph10-settings-main`）: メモA `メモA 設定テストの出典メモ`（`01a08e87-740c-…`）、メモB `メモB 二つ目の出典メモ`（`01a08e87-7ffb-…`）、メモC `メモC 別日に移すメモ`（`01a08e87-8be6-…`）、履歴ありメモ `旧バージョン の本文を持つメモ` → UI で `最新版の本文を持つメモ（編集済み）`（r2）、ゴミ箱: `削除済みテキストX を含むメモ` / `削除するドキュメント`（本文 `削除済みドキュメント本文Y`）。トピックA（`ドキュメントA 出典2件`（出典 メモA・メモB）/ `ドキュメントA2`）、トピックB（`ドキュメントB1`、完了済み）。ドキュメントは `scratchpad/aicB`（ai-client の複製）で作成。**投稿日の違うメモ**: 12:54 に dev を止め `f869b80f…sqlite` で メモC を −2 日（9/9）、メモA を −1 日（9/10）にずらした
- ブラウザの時間帯: agent-browser の Chrome は `Asia/Tokyo`（エクスポートの hidden `timezone` も `Asia/Tokyo`）
- 集計: 合格 12 / 不合格 0 / 実行不能 0 / 保留 0 / 未実施 0（全 12）。zip の展開は macOS 同梱の `unzip`（UnZip 6.00, Apple 版）が非 ASCII 名で失敗するため `ditto -x -k` と Python `zipfile` を使った（下記）

| TC | 種別 | 判定 | 時刻 | 備考（観測した値・代替） |
|---|---|---|---|---|
| TC-01 | 正常系 | 合格 | 12:37 | 「ゴミ箱の保持期限」に `30`。`7` で保存 → 「保存しました。既存のゴミ箱の項目にも適用されます」、入力 `7`、`現在: 7 日`。リロード後も `7`。保存直後 30 ms の DOM: ボタン `disabled` + 「保存中…」、入力も `disabled`（項目単位の保存中表示） |
| TC-02 | 正常系 | 合格 | 12:37 | 変更前はゴミ箱の 2 件が `残り30日`（12:36 に削除）→ 7 日に変更後 `残り7日`。変更後に `TC02 設定変更後に削除するメモ` を削除 → `残り7日`（既存・新規とも 7 日基準） |
| TC-07 | 境界値 | 合格 | 12:38 | `1` で保存 → 成功表示、リロードで `1`、ゴミ箱の 3 件が `残り1日` |
| TC-08 | 境界値 | 合格 | 12:38 | `0` → ネイティブ検証（`値は 1 以上にする必要があります。`）で送信されない。`noValidate` で回避 → 「1 以上の整数を入力してください」（role=alert、項目の直下）、保存されずリロードで `1`。`7` に直して保存 → エラーが消え「保存しました」 |
| TC-09 | 異常系 | 合格 | 12:39 | `-1` は入力できる（`type=number`）→ ネイティブ検証で送信されない。`noValidate` で回避 → 「1 以上の整数を入力してください」。リロードで変更前の `7`。`c734ddb` 以降は拒否後も入力 `-1` が残る（修正前は既定値に戻っていた） |
| TC-10 | 異常系 | 合格 | 12:39 | `abc` は `fill` で入らない（値 `""`）/ 空欄 →「このフィールドを入力してください。」、`1.5` →「有効な値を入力してください。有効な値として最も近いのは 1 と 2 です。」（いずれもネイティブ検証）。`noValidate` で回避すると 3 つとも「1 以上の整数を入力してください」、保存されない。リロードで `7`。追加: `36501`（transport 上限超え）→ `c734ddb` 以降「36,500 日以下で入力してください」 |
| TC-03 | 正常系 | 合格 | 13:03 | 「エクスポート」→ 直後の DOM は `aria-busy=true` +「生成中…」（role=status）→ zip を保存（`agent-browser download`）。ファイル名は `fog-export-20260911.zip`（`<a download>`、Asia/Tokyo の今日）。`ditto -x -k` で展開 → ルートに `fog-export-20260911/` が 1 つ。ファイル: `index.md` / `memos/2026-09-09.md` / `2026-09-10.md` / `2026-09-11.md`（投稿日 3 日ぶん）/ `topics/トピックA/{index.md, ドキュメントA-出典2件.md, ドキュメントA2.md}` / `topics/トピックB/{index.md, ドキュメントB1.md}`。すべて `.md`。manifest は `type: manifest` / `exportedAt: 2026-09-11T13:03:05+09:00` / `timezone: Asia/Tokyo` / `counts: memos 4, topics 2, documents 3`（ゴミ箱の 3 件を除いた数と一致）。日別ファイルは `## HH:mm (memoId)` 見出しが時刻の昇順、本文は最新（`最新版の本文を持つメモ（編集済み）`） |
| TC-04 | 正常系 | 合格 | 13:03 | `topics/トピックB/` に `index.md` + `ドキュメントB1.md`、`index.md` の frontmatter `type: topic` / `archived: true`。トピックA は `archived: false` |
| TC-05 | 正常系 | 合格 | 13:03 | 展開ディレクトリで `grep -r` → `削除済みテキストX` / `旧バージョン` / `削除済みドキュメント本文Y` / `TC02` とも 0 件。履歴ありメモは最新本文だけが `memos/2026-09-11.md` に出る。`counts` にゴミ箱の項目を含まない |
| TC-06 | 正常系 | 合格 | 13:03〜13:04 | `ドキュメントA-出典2件.md` の frontmatter に `type: document` / `documentId` / `title` / `topic: "トピックA"` / `sources`。2 件とも `memoId` / `postedAt` / `file: ../../memos/2026-09-10.md`・`../../memos/2026-09-11.md`、辿った先の日別ファイルに同じ `memoId` の見出し。本文は `# ドキュメントA\n\n出典は二つのメモ。` のみ。確認ポイント（時間があれば）も実施: メモB をゴミ箱へ入れて再エクスポート → その source は `memoId` + `deleted: true` のみ（`file` / `postedAt` なし）、`counts.memos` は 3。メモB は復元済み |
| TC-11 | 境界値 | 合格 | 12:29 | `ph10-settings-empty`（登録直後）でエクスポート → エラーなしで zip。中身は `fog-export-20260911/index.md` の 1 ファイルだけ（`memos/` / `topics/` なし）、`counts` は 0 / 0 / 0 |
| TC-12 | 異常系 | 合格 | 13:05 | ログアウト → `/login`。`/settings` を直接開く → `/login?redirect=%2Fsettings` → ログインで `/settings` に戻る |

## 環境依存（FAIL にしない）

- **macOS 同梱の `unzip`**（`/usr/bin/unzip`、UnZip 6.00 Apple 版）は非 ASCII のパス（`topics/トピックA/…`）を「Illegal byte sequence」で展開できない（exit 2、ASCII 名の 4 ファイルだけ展開）。zip 自体は正しい: 非 ASCII 名のエントリは general purpose bit 11（UTF-8、`0x800`）が立ち、ASCII 名は `0x0`（Python `zipfile` で確認）。`ditto -x -k`（Finder と同じ展開）と Python `zipfile` では全 9 ファイルが正しい名前で展開される。README / docs/runtime_cloudflare.md §13 に記載済みの限界
- zip エントリの DOS 時刻は `04:03`（UTC）。workerd のプロセス TZ が UTC のため（PH-08 O-1、`zipArchiveWriter` の JSDoc に限界として記載）。ファイル名・`exportedAt`・日別ファイルの日付はブラウザの `Asia/Tokyo` で決まっている
