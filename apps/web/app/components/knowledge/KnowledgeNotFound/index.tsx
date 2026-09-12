import { ButtonLink } from "@/components/ui/ButtonLink";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * The 「見つからない」 state of P-07 / P-08 / P-09 / P-10: a wrong or
 * deleted id, as one sentence with the way back to the topic list
 * (`spec/design/pages/topic-detail.html`, 状態の例「トピック不在」).
 *
 * On a screen whose route leaves the `h1` to a title this state stands in
 * for (`h1: "sheet"`), the sentence is that heading. It is told so rather
 * than reading `usePageHeadingOwner`, because this is drawn in the streamed
 * RSC tree, where the client frame's context does not reach.
 */
export function KnowledgeNotFound({
  subject,
  asPageHeading = false,
}: {
  subject: "トピック" | "ドキュメント";
  asPageHeading?: boolean;
}) {
  return (
    <EmptyState
      message={`${subject}が見つかりません`}
      asPageHeading={asPageHeading}
      action={
        <ButtonLink variant="fill" to="/topics">
          トピック一覧へ
        </ButtonLink>
      }
    />
  );
}
