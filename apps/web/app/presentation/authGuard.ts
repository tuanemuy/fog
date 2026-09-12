import { redirect } from "@tanstack/react-router";
import { readAuthStateFn } from "./authState";
import { toSafeRedirect } from "./redirectSearch";

/**
 * The `beforeLoad` of every layout whose screens need a session: `_app`
 * (the app shell) and `_sheet/_authenticated` (the two auth-sheet screens a
 * session reaches — AI client authorization and the reset's done page).
 * One definition, so the two layouts cannot drift.
 *
 * A navigation aid, never the guard: it bounces an unauthenticated visitor
 * to `/login` with the current URL to return to, and every server execution
 * point that reads protected data calls `requireUserId()` itself. It goes
 * through `readAuthStateFn`, whose `noStoreMiddleware` is what stamps
 * `Cache-Control: no-store` on every document under those layouts — so a
 * layout that needs a session takes this as its `beforeLoad`, not a copy.
 */
export async function requireSessionBeforeLoad({
  location,
}: Readonly<{ location: Readonly<{ href: string }> }>): Promise<void> {
  const { authenticated } = await readAuthStateFn();
  if (authenticated) return;
  const target = toSafeRedirect(location.href);
  throw redirect({
    to: "/login",
    search: target === undefined || target === "/" ? {} : { redirect: target },
  });
}
