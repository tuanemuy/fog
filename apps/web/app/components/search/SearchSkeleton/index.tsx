import { LoadingRow } from "@/components/ui/LoadingRow";
import { Sk } from "@/components/ui/Sk";
import { SearchBox } from "../SearchBox";
import { CHIP_CLASS, CHIP_IDLE_CLASS, CHIP_LIST_CLASS } from "../styles";

const STAND_IN_CHIPS = ["すべて", "読書メモ", "引っ越し", "確定申告 2025"];

export type SearchSkeletonProps = Readonly<{
  /** The keyword in the URL, already in the box while its results load. */
  q: string | undefined;
}>;

/**
 * Stands in for `SearchPanel` while it streams, on the same DOM: the keyword
 * box with its input disabled, the chip row with its names under `Sk`
 * (inert, and hidden from assistive technology), and where the results will
 * be, 検索中 — or 読み込み中 when there is no keyword, only the chips to load.
 */
export function SearchSkeleton({ q }: SearchSkeletonProps) {
  return (
    <div aria-busy="true" className="flex flex-col gap-lg">
      <SearchBox defaultValue={q ?? ""} loading />
      <ul className={CHIP_LIST_CLASS} aria-hidden="true">
        {STAND_IN_CHIPS.map((name) => (
          <li key={name}>
            <span className={`${CHIP_CLASS} ${CHIP_IDLE_CLASS}`}>
              <Sk>{name}</Sk>
            </span>
          </li>
        ))}
      </ul>
      <LoadingRow label={q === undefined ? "読み込み中" : "検索中"} />
    </div>
  );
}
