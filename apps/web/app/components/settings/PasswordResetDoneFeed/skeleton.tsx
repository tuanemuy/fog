import { Button } from "@/components/ui/Button";
import { LoadingRegion } from "@/components/ui/LoadingRegion";
import { Row } from "@/components/ui/Row";
import { RowList } from "@/components/ui/RowList";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { Sk } from "@/components/ui/Sk";
import { DONE_ACTIONS_CLASS, DONE_SECTION_CLASS } from "./styles";

function SkeletonRow({ name, meta }: Readonly<{ name: string; meta: string }>) {
  return (
    <li>
      <Row>
        <p>
          <Sk>{name}</Sk>
        </p>
        <p className="mt-xs font-base text-xs leading-tight text-neutral-400">
          <Sk>{meta}</Sk>
        </p>
      </Row>
    </li>
  );
}

/**
 * The done page while `PasswordResetDoneFeed` streams in: the same blocks,
 * labels and button, with one row per block whose
 * text is laid over by `Sk`. The labels are fixed words, so they are drawn
 * as they will be. One polite loading label speaks for the region; the rest
 * is hidden from assistive technology, and the button cannot be pressed.
 */
export function PasswordResetDoneSkeleton() {
  return (
    <LoadingRegion>
      <div aria-hidden="true">
        <section className={DONE_SECTION_CLASS}>
          <SectionLabel>ログイン手段</SectionLabel>
          <RowList>
            <SkeletonRow
              name="tanaka.yui@example.com"
              meta="メール・パスワード"
            />
          </RowList>
        </section>
        <section className={DONE_SECTION_CLASS}>
          <SectionLabel>AI</SectionLabel>
          <RowList>
            <SkeletonRow
              name="Claude Desktop"
              meta="接続: 2025年12月15日 / 最終利用: 2026年9月10日"
            />
          </RowList>
        </section>
        <div className={DONE_ACTIONS_CLASS}>
          <Button variant="fill" disabled tabIndex={-1}>
            タイムラインへ進む
          </Button>
        </div>
      </div>
    </LoadingRegion>
  );
}
