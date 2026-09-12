"use client";

import { LoadingRegion } from "@/components/ui/LoadingRegion";
import { RowList } from "@/components/ui/RowList";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { SHEET_TITLE_CLASS } from "@/components/ui/SheetTitle";
import { Sk } from "@/components/ui/Sk";
import {
  HISTORY_SECTION_CLASS,
  RevisionRowText,
  StaticRevisionRow,
} from "../RevisionList";

export type RevisionHistorySkeletonProps = Readonly<{
  /**
   * Which history is loading: the document's opens with its title, the
   * memo's with the list (`spec/design/pages/*-history.html`, 状態の例).
   */
  subject: "memo" | "document";
}>;

const STAND_IN_TIME = "2026年7月20日 12:42";

/**
 * The history screens while their fragment streams in: the same title,
 * section and version rows as the loaded screen, the text laid over by
 * `Sk`, so the swap moves nothing. 「履歴」 is the
 * screen's own word, not loaded data, and is drawn as it will stay. P-10
 * leaves the `h1` to the document's title, so the loading label stands in
 * for it until that title arrives.
 */
export function RevisionHistorySkeleton({
  subject,
}: RevisionHistorySkeletonProps) {
  const meta = subject === "document" ? "あなた · 手動編集" : "あなた";
  const history = (
    <>
      <SectionLabel>履歴</SectionLabel>
      <RowList ordered>
        {[0, 1, 2].map((n) => (
          <StaticRevisionRow key={n}>
            <RevisionRowText
              time={<Sk>{STAND_IN_TIME}</Sk>}
              meta={<Sk>{meta}</Sk>}
            />
          </StaticRevisionRow>
        ))}
      </RowList>
    </>
  );
  return (
    <LoadingRegion asPageHeading={subject === "document"}>
      {subject === "document" ? (
        <>
          <p className={SHEET_TITLE_CLASS}>
            <Sk>ドキュメントのタイトル</Sk>
          </p>
          <div className={HISTORY_SECTION_CLASS}>{history}</div>
        </>
      ) : (
        history
      )}
    </LoadingRegion>
  );
}
