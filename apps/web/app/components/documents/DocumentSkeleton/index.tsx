import { LoadingRegion } from "@/components/ui/LoadingRegion";
import { SHEET_TITLE_CLASS } from "@/components/ui/SheetTitle";
import { Sk } from "@/components/ui/Sk";
import { DOC_BODY_CLASS, DOC_CONTEXT_CLASS, DOC_META_CLASS } from "../styles";

/**
 * - `read` — P-08: the topic, the title, the update time and the body
 * - `edit` — P-09 in either mode: the topic, the title field and the body
 *   field
 */
export type DocumentSkeletonMode = "read" | "edit";

// The body's lines as `Markdown`'s document variant sets them: the reading
// leading, and a paragraph's `1.3em` over each one after the first.
const BODY_TEXT_CLASS = "font-base text-base leading-loose";
const NEXT_PARAGRAPH_CLASS = "mt-[1.3em]";

/**
 * The document screens while their fragment streams in
 * (`spec/design/pages/document.html` / `document-edit.html`, 読み込み中): the
 * loaded screen's lines, from the same classes, with `Sk` over the text. The
 * title stays out of the heading outline until the real one arrives; on P-08,
 * whose route leaves the `h1` to that title, the loading label stands in for
 * it meanwhile.
 */
export function DocumentSkeleton({ mode }: { mode: DocumentSkeletonMode }) {
  return (
    <LoadingRegion asPageHeading={mode === "read"}>
      <p className={DOC_CONTEXT_CLASS}>
        <Sk>ブランド刷新</Sk>
      </p>
      <p className={SHEET_TITLE_CLASS}>
        <Sk>サイト構成の方針</Sk>
      </p>
      {mode === "read" ? (
        <>
          <p className={DOC_META_CLASS}>
            <Sk>2026年7月20日 12:42 更新</Sk>
          </p>
          <div className={`${DOC_BODY_CLASS} ${BODY_TEXT_CLASS}`}>
            <p>
              <Sk>
                トップは製品ではなく制作の姿勢を見せる。写真は現場のものだけを使い、素材集は使わない。
              </Sk>
            </p>
            <p className={NEXT_PARAGRAPH_CLASS}>
              <Sk>色は現行の紺を残す。書体は本文と見出しの二種に絞る。</Sk>
            </p>
          </div>
        </>
      ) : (
        <div className={`mt-lg ${BODY_TEXT_CLASS}`}>
          <p>
            <Sk>
              トップは製品ではなく制作の姿勢を見せる。写真は現場のものだけを使い、素材集は使わない。
            </Sk>
          </p>
          <p className={NEXT_PARAGRAPH_CLASS}>
            <Sk>構成：姿勢を伝える一枚と最小限の導線</Sk>
          </p>
        </div>
      )}
    </LoadingRegion>
  );
}
