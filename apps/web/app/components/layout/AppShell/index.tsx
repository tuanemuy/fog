"use client";

import { Link, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";
import { Brand } from "@/components/layout/Brand";

/**
 * The five destinations of the common layout (`spec/pages/index.md`). Every
 * entry is a real route; a screen that does not exist yet is not listed, so
 * the shell never links into a 404.
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

const MEMO_HISTORY_PATH = /^\/memos\/[^/]+\/history$/;

const TITLES: ReadonlyArray<readonly [(path: string) => boolean, string]> = [
  [(path) => path === "/", "タイムライン"],
  [(path) => MEMO_HISTORY_PATH.test(path), "メモ履歴"],
  [(path) => path === "/topics", "トピック"],
  [
    (path) => /^\/topics\/[^/]+\/documents\/new$/.test(path),
    "ドキュメント作成",
  ],
  [(path) => /^\/topics\/[^/]+$/.test(path), "トピック詳細"],
  [(path) => /^\/documents\/[^/]+\/edit$/.test(path), "ドキュメント編集"],
  [(path) => /^\/documents\/[^/]+\/history$/.test(path), "ドキュメント履歴"],
  [(path) => /^\/documents\/[^/]+$/.test(path), "ドキュメント"],
  [(path) => path === "/search", "検索"],
  [(path) => path === "/trash", "ゴミ箱"],
  [(path) => path === "/settings", "設定"],
];

export function titleFor(pathname: string): string {
  return TITLES.find(([matches]) => matches(pathname))?.[1] ?? "fog";
}

/**
 * Sidebar on desktop, a bottom sheet behind the menu button on mobile
 * (`spec/design/pages/timeline.html`). Pure layout: the account actions
 * (logout) live on the settings screen.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const navigation = (
    <>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="fog-side-link"
          aria-current={item.match(pathname) ? "page" : undefined}
          onClick={() => dialog.current?.close()}
        >
          <span className="fog-nav-dot" />
          {item.label}
        </Link>
      ))}
    </>
  );
  return (
    <div className="fog-app">
      <a className="fog-skip" href="#main">
        本文へ移動
      </a>
      <aside className="fog-sidebar">
        <Link to="/" aria-label="fog タイムライン">
          <Brand />
        </Link>
        <nav aria-label="メインナビゲーション">{navigation}</nav>
      </aside>
      <div className="fog-main-column">
        <header className="fog-header">
          <div className="fog-mobile-brand">
            <Brand />
          </div>
          <h1>{titleFor(pathname)}</h1>
          <button
            type="button"
            className="fog-mobile-menu"
            aria-label="メニューを開く"
            aria-haspopup="dialog"
            onClick={() => dialog.current?.showModal()}
          >
            メニュー
          </button>
        </header>
        <main
          id="main"
          className="fog-sheet"
          data-scroll-restoration-id="app-sheet"
        >
          {children}
        </main>
      </div>
      <dialog
        ref={dialog}
        className="fog-nav-dialog"
        aria-labelledby="fog-nav-title"
      >
        <div className="fog-content-toolbar">
          <h2 id="fog-nav-title">メニュー</h2>
          <button
            type="button"
            className="fog-text-button"
            onClick={() => dialog.current?.close()}
            aria-label="メニューを閉じる"
          >
            閉じる
          </button>
        </div>
        <nav aria-label="モバイルナビゲーション">{navigation}</nav>
      </dialog>
    </div>
  );
}
