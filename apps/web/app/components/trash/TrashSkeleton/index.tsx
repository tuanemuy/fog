import { Button } from "@/components/ui/Button";
import { LoadingRegion } from "@/components/ui/LoadingRegion";
import { Row } from "@/components/ui/Row";
import { RowList } from "@/components/ui/RowList";
import { Sk } from "@/components/ui/Sk";
import {
  KindPill,
  RemainingDays,
  TrashHeader,
  TrashRowActions,
  TrashTags,
} from "../TrashParts";

const STAND_INS = [
  { title: "昼に食べた店、名前なんだったか。駅の北側。", kind: "メモ" },
  { title: "打ち合わせ前の走り書き。", kind: "メモ" },
  { title: "2024年Q1レビュー", kind: "ドキュメント" },
] as const;

/**
 * Shaped to `TrashBoard` from the same parts: the
 * header, then three rows whose text is laid over by `Sk` and whose buttons
 * are drawn disabled. The one busy status and its label are the whole of
 * what assistive technology reads; the stand-in rows are hidden from it.
 */
export function TrashSkeleton() {
  return (
    <LoadingRegion>
      <div aria-hidden="true">
        <TrashHeader
          action={
            <Button variant="danger-text" disabled>
              <Sk>空にする（0）</Sk>
            </Button>
          }
        />
        <RowList>
          {STAND_INS.map(({ title, kind }) => (
            <li key={title}>
              <Row actions={<TrashRowActions title={title} disabled />}>
                <p>
                  <Sk>{title}</Sk>
                </p>
                <TrashTags>
                  <KindPill>
                    <Sk>{kind}</Sk>
                  </KindPill>
                  <RemainingDays>
                    <Sk>残り30日</Sk>
                  </RemainingDays>
                </TrashTags>
              </Row>
            </li>
          ))}
        </RowList>
      </div>
    </LoadingRegion>
  );
}
