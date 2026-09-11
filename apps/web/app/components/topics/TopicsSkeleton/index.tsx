import { LoadingRegion } from "@/components/ui/LoadingRegion";
import { Row } from "@/components/ui/Row";
import { RowList } from "@/components/ui/RowList";
import { Sk } from "@/components/ui/Sk";
import { TOPIC_DESC_CLASS, TOPIC_NAME_CLASS } from "../styles";

/**
 * Where a `…` menu's trigger will be: its box (the row placement's padding
 * around the small glyph), empty, and nothing to press.
 */
export function MenuPlaceholder() {
  return (
    <span aria-hidden="true" className="flex p-xs">
      <span className="size-icon-sm" />
    </span>
  );
}

const ROWS = [
  { name: "ブランド刷新", description: "サイトとロゴの見直し。秋の展示会まで" },
  { name: "引っ越し", description: "候補エリアの比較と手続きのまとめ" },
  { name: "読書メモ", description: "今年読んだ本の抜き書き" },
] as const;

/**
 * P-06 while it loads (`spec/design/pages/topics.html`, 状態の例): three
 * topic rows built from `TopicList`'s own list, rows and text classes, with
 * the text laid over by `Sk` and the menus left as empty boxes.
 */
export function TopicsSkeleton() {
  return (
    <LoadingRegion>
      <RowList>
        {ROWS.map((row) => (
          <li key={row.name}>
            <Row actions={<MenuPlaceholder />}>
              <span className={TOPIC_NAME_CLASS}>
                <Sk>{row.name}</Sk>
              </span>
              <span className={TOPIC_DESC_CLASS}>
                <Sk>{row.description}</Sk>
              </span>
            </Row>
          </li>
        ))}
      </RowList>
    </LoadingRegion>
  );
}
