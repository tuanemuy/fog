import { ButtonLink } from "@/components/ui/ButtonLink";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * The 「見つからない」 state of P-07 / P-08 / P-09 / P-10: a wrong or
 * deleted id, as one sentence with the way back to the topic list
 * (`spec/design/pages/topic-detail.html`, 状態の例「トピック不在」).
 */
export function KnowledgeNotFound({
  subject,
}: {
  subject: "トピック" | "ドキュメント";
}) {
  return (
    <EmptyState
      message={`${subject}が見つかりません`}
      action={
        <ButtonLink variant="fill" to="/topics">
          トピック一覧へ
        </ButtonLink>
      }
    />
  );
}
