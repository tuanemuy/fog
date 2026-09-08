import { Link } from "@tanstack/react-router";

/**
 * The 「見つからない」 state of P-07 / P-08 / P-09 / P-10: a wrong or
 * deleted id, with the way back to the topic list (`spec/pages/index.md`).
 */
export function KnowledgeNotFound({
  subject,
}: {
  subject: "トピック" | "ドキュメント";
}) {
  return (
    <div className="fog-history fog-empty" role="status">
      <h2>{subject}が見つかりません</h2>
      <p>削除されたか、URL の ID が正しくありません。</p>
      <p>
        <Link to="/topics" className="fog-secondary fog-link-button">
          トピック一覧へ
        </Link>
      </p>
    </div>
  );
}
