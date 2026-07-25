/**
 * The five signed-in destinations (PAGE-common-001).
 *
 * Shared by the shell's navigation and each route's `head`, so a screen's
 * label and its `<title>` cannot drift apart.
 */
export const NAV_ITEMS = [
  { to: "/", label: "タイムライン" },
  { to: "/topics", label: "トピック" },
  { to: "/search", label: "検索" },
  { to: "/trash", label: "ゴミ箱" },
  { to: "/settings", label: "設定" },
] as const;

export type NavPath = (typeof NAV_ITEMS)[number]["to"];

export function navTitle(path: NavPath): string {
  const item = NAV_ITEMS.find((candidate) => candidate.to === path);
  return item === undefined ? "fog" : item.label;
}
