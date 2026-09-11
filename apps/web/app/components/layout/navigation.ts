/**
 * The five destinations of the common layout (`spec/pages/index.md`), in the
 * order the sidebar and the nav sheet list them. Every entry is a real route;
 * a screen that does not exist yet is not listed, so the shell never links
 * into a 404. `match` decides which item marks the current place.
 */
export const NAV_ITEMS = [
  {
    to: "/",
    label: "タイムライン",
    match: (path: string) => path === "/" || path.startsWith("/memos"),
  },
  {
    to: "/topics",
    label: "トピック",
    match: (path: string) =>
      path.startsWith("/topics") || path.startsWith("/documents"),
  },
  {
    to: "/search",
    label: "検索",
    match: (path: string) => path === "/search",
  },
  {
    to: "/trash",
    label: "ゴミ箱",
    match: (path: string) => path === "/trash",
  },
  {
    to: "/settings",
    label: "設定",
    match: (path: string) => path === "/settings",
  },
] as const;

export type NavItem = (typeof NAV_ITEMS)[number];
