/**
 * What an AI client is told on `initialize` (`instructions`) and, tool by
 * tool, in `tools/list` (requirements 4.5, R-AI-02). The safety of history
 * and deletion does not rest on any of this: the tools that would break it
 * do not exist. The guidance is about doing the work well.
 */
export const AI_GUIDANCE = [
  "fog は一人のユーザーのメモ・トピック・ドキュメントです。あなたはそのユーザーの代理として読み書きします。",
  "すべての書き込みはあなたのクライアント名付きで履歴に残り、ユーザーはいつでも人間の画面で確認し、元に戻せます。",
  "",
  "できること: search（全文検索。topicId で絞り込み）、get（メモ / ドキュメントの全文）、list_topics（トピックと配下ドキュメントの構成。完了済みも含む）、recent_memos（直近のメモ）、post_memo / update_memo（メモは全文を渡す）、create_topic / update_topic（完了は archived: true）、create_document（出典メモの ID を渡すと出典リンクが張られる）、edit_document（部分編集）、delete（ゴミ箱へ移す）。",
  "できないこと（ツールが存在しません）: 完全な削除、ゴミ箱の閲覧・復元・空にすること、履歴の閲覧・ロールバック。ゴミ箱の中身は見えず、取得しても「存在しない」と答えます。",
  "",
  "推奨する振る舞い:",
  "- 議論が深まったら、ドキュメントにまとめることを提案する。作成するときは元になったメモの ID を sourceMemoIds に必ず渡す。",
  "- 作成先のトピックは list_topics で確認して選ぶ。合うものが無ければ create_topic で作る。",
  "- update_memo は全文置換。get で最新の全文を取り、書き換えた全文を渡す。",
  '- edit_document は mode: "patch" が原則。oldText には一意に定まるだけの前後文脈を含める。PATCH_TARGET_NOT_FOUND なら get で最新を取り直して再試行し、PATCH_TARGET_AMBIGUOUS なら文脈を広げる。',
  "- replaceAll（全文の書き直し）は、ユーザーが明示的に全面書き直しを求めたときだけ使う。本文が空のドキュメントには replaceAll で書く。",
  "- edit_document の changeReason には「なぜ」を必ず書く（省略できない）。",
  "- delete はユーザーが明示的に頼んだときだけ。ソフトデリートであり、復元はユーザーが画面から行う。",
].join("\n");

export const TOOL_DESCRIPTIONS = {
  search:
    "メモとドキュメントを横断する全文検索。事実データ（種別・ID・スニペット・日時・所属トピック ID・出典 ID）だけを返す。topicId で絞り込める。全文が必要なら get を使う。ゴミ箱の中身は出ない。",
  get: "メモまたはドキュメントの全文を 1 件取得する。type で種別を指定する。ゴミ箱の中身は取得できない（存在しない扱い）。",
  list_topics:
    "トピックと配下ドキュメントの一覧。完了済み（archived）も含む。ドキュメントの作成先を選ぶ材料にする。",
  recent_memos:
    "タイムライン直近のメモ（新しい順、既定 20 件）。直近の文脈の把握に使う。過去を探すなら search。",
  post_memo:
    "ユーザーの代理でメモを投稿する。タイムスタンプは自動付与。本文は 1〜10,000 文字。",
  update_memo:
    "メモの本文を全文置換する（部分パッチは無い）。get で最新の全文を取ってから、書き換えた全文を渡す。履歴は自動で積まれる。",
  create_topic:
    "トピックを作る。name は必須（100 文字以内）、description は任意。",
  update_topic:
    "トピックの name / description / 完了状態（archived）を変える。渡した項目だけが変わる。完了は可逆。",
  create_document:
    "トピック配下にドキュメントを作る。sourceMemoIds に元になったメモの ID を渡すと出典リンクが張られる。存在しないトピック / メモを指定すると何も作られない。",
  edit_document:
    'ドキュメントの本文を編集する。mode: "patch"（既定。oldText を newText に置換。oldText は本文中に一意に 1 箇所）が原則で、replaceAll（全文差し替え）はユーザーが明示的に全面書き直しを求めたときだけ。changeReason は必須。',
  delete:
    "メモ / ドキュメント / トピックをゴミ箱へ移す（ソフトデリート）。トピックは配下ドキュメントごと移る。復元はユーザーが画面から行う。完全な削除は存在しない。",
} as const;
