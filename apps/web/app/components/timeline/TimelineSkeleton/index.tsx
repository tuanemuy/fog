import { LoadingRegion } from "@/components/ui/LoadingRegion";
import { Sk } from "@/components/ui/Sk";
import {
  DAY_ENTRIES_CLASS,
  DAY_HEADING_CLASS,
  ENTRY_BODY_CLASS,
  ENTRY_CLASS,
  ENTRY_HEAD_CLASS,
  TIME_LABEL_CLASS,
} from "../styles";

const STAND_INS = [
  [
    "10:30",
    "今日は仕事が捗った。プロジェクトが前に進んで、チームからも良い反応をもらえた。",
  ],
  ["12:30", "ワイヤーフレームの構成を固めた。"],
  [
    "13:30",
    "午後の打ち合わせの控え。論点は三つで、価格の見直し、対象範囲、スケジュール。",
  ],
] as const;

/**
 * The timeline while its list streams in (`spec/design/pages/timeline.html`,
 * 状態の例「読み込み中」): a day heading and three entries in the list's own
 * elements and classes, with only the text laid over by `Sk`, so the loaded
 * list swaps in without a shift. The menu trigger's place is kept by an
 * empty box of its size. One polite announcement for the region.
 */
export function TimelineSkeleton() {
  return (
    <LoadingRegion>
      {/* Not an `h2`: its only text is the hidden stand-in, and an empty
          heading would still be announced. The classes make the same box. */}
      <div className={DAY_HEADING_CLASS}>
        <Sk>2026年7月22日(水)</Sk>
      </div>
      <div className={DAY_ENTRIES_CLASS}>
        {STAND_INS.map(([time, body]) => (
          <div className={ENTRY_CLASS} key={time}>
            <div className={ENTRY_HEAD_CLASS}>
              <span className={TIME_LABEL_CLASS}>
                <Sk>{time}</Sk>
              </span>
              <span aria-hidden="true" className="flex p-xs">
                <span className="size-icon-sm" />
              </span>
            </div>
            <div className={ENTRY_BODY_CLASS}>
              <p className="font-base text-base leading-normal">
                <Sk>{body}</Sk>
              </p>
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
