import { ERROR_TITLE, ErrorRetry } from "@/components/ui/ErrorRetry";

/**
 * The in-shell failure surface: heading, optional detail, retry affordance.
 *
 * Rendered by `_app`'s `errorComponent` (which stands in for a whole
 * protected screen) and by any route that needs a boundary of its own
 * (`/settings`, so its sign-out survives the panel failing). Both used to
 * carry a verbatim copy of this body; sharing it is what keeps a change to
 * one from silently leaving the other behind.
 *
 * `className` carries the only intended difference between them: `_app`
 * replaces the screen and pads both ends, while a route-level surface
 * appears below content the route deliberately kept on screen, so it pads
 * the bottom only. The standalone sheet in `__root.tsx` is a different
 * shape — `AuthSheet`'s `title` / `description` — and stays separate.
 */
export function ErrorSurface({
  message,
  className = "py-2xl",
}: {
  message: string;
  className?: string;
}) {
  return (
    <section className={`flex flex-col gap-lg ${className}`}>
      <h2 className="text-xl font-bold leading-tight">{ERROR_TITLE}</h2>
      {/* The generic fallback message is the heading itself; repeating it
          under the heading says nothing. */}
      {message === ERROR_TITLE ? null : (
        <p className="text-base text-neutral-600 text-balance">{message}</p>
      )}
      <ErrorRetry />
    </section>
  );
}
