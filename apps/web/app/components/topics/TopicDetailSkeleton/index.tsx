import { KnowledgeSection } from "@/components/knowledge/KnowledgeSection";
import { Button } from "@/components/ui/Button";
import { RowList } from "@/components/ui/RowList";
import { Sk } from "@/components/ui/Sk";
import {
  DOCUMENT_META_CLASS,
  DOCUMENT_NAME_CLASS,
  TOPIC_DETAIL_DESC_CLASS,
  TOPIC_HEAD_CLASS,
  TOPIC_STATUS_CLASS,
  TOPIC_TITLE_CLASS,
} from "../styles";
import { MenuPlaceholder } from "../TopicsSkeleton";

const DOCUMENTS = [
  { title: "サイト構成の方針", meta: "7月20日 更新" },
  { title: "ロゴ検討の経緯", meta: "7月16日 更新" },
] as const;

/**
 * P-07 while it loads (`spec/design/pages/topic-detail.html`, 状態の例): the
 * head, the status line and two document rows, from `TopicDetailFeed`'s own
 * classes and sections, with the text laid over by `Sk`. The one action is
 * the real outline button, disabled and hidden from assistive technology, so
 * its box is the loaded one's. The document rows are the `RowLink` box
 * without the link: nothing here reacts.
 */
export function TopicDetailSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">読み込み中</span>
      <div className={TOPIC_HEAD_CLASS}>
        <p className={TOPIC_TITLE_CLASS}>
          <Sk>ブランド刷新</Sk>
        </p>
        <MenuPlaceholder />
      </div>
      <p className={TOPIC_DETAIL_DESC_CLASS}>
        <Sk>サイトとロゴの見直し。秋の展示会まで</Sk>
      </p>
      <div className={TOPIC_STATUS_CLASS} aria-hidden="true">
        <Button variant="outline" disabled tabIndex={-1}>
          <Sk>完了にする</Sk>
        </Button>
      </div>
      <KnowledgeSection label="ドキュメント">
        <RowList>
          {DOCUMENTS.map((document) => (
            <li key={document.title}>
              <div className="flex items-center gap-md py-row font-base text-base leading-normal">
                <span className="min-w-[0] flex-1">
                  <span className={DOCUMENT_NAME_CLASS}>
                    <Sk>{document.title}</Sk>
                  </span>
                  <span className={DOCUMENT_META_CLASS}>
                    <Sk>{document.meta}</Sk>
                  </span>
                </span>
              </div>
            </li>
          ))}
        </RowList>
      </KnowledgeSection>
    </div>
  );
}
