import { Sk } from "@/components/ui/Sk";

const LINE_CLASS = "font-base text-base leading-normal";

/**
 * Generic, route-level navigation pending UI.
 *
 * Wired as the router's `defaultPendingComponent`: shown while a route whose
 * loader genuinely blocks resolves (past `defaultPendingMs`). Routes that
 * stream their own content via `<Suspense>` settle their loader instantly and
 * never trigger this — they rely on a per-fragment skeleton instead.
 *
 * It stands in for no screen in particular, so it is a title and two lines of
 * body text built from real text elements with the text laid over by `Sk`
 * (ADR-005 of Issue #22): it does not animate. `role="status"` +
 * `aria-live="polite"` + the sr-only label give one polite announcement for
 * the whole region; the stand-in text is hidden from assistive technology.
 * It holds no padding or width of its own: the frame it is drawn in does.
 */
export function RoutePendingFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex flex-col gap-md"
    >
      <span className="sr-only">読み込み中</span>
      <p className="font-base text-xl font-semibold leading-tight">
        <Sk>ページを読み込んでいます</Sk>
      </p>
      <p className={LINE_CLASS}>
        <Sk>読み込みが終わると、この位置に画面の中身が入ります。</Sk>
      </p>
      <p className={LINE_CLASS}>
        <Sk>しばらくお待ちください。</Sk>
      </p>
    </div>
  );
}
