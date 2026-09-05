"use client";

import type { HumanActor } from "@repo/core/application/fog/types";
import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useActionState, useRef } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { logoutFog } from "@/presentation/fogActions";
import { Brand } from "./Brand";

export function FogShell({
  actor,
  children,
  title = "タイムライン",
  backHref,
}: {
  actor: HumanActor;
  children: ReactNode;
  title?: string;
  backHref?: string;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const topicActive =
    pathname.startsWith("/topics") || pathname.startsWith("/documents");
  const dialog = useRef<HTMLDialogElement>(null);
  const logout = useServerFn(logoutFog);
  const [error, action, pending] = useActionState<string | null, FormData>(
    async () => {
      try {
        await logout({ data: {} });
        window.location.replace("/login");
        return null;
      } catch (failure) {
        return displayError(failure);
      }
    },
    null,
  );
  const account = (
    <form action={action} className="fog-account">
      <span className="fog-email" title={actor.email}>
        {actor.email}
      </span>
      <button type="submit" className="fog-text-button" disabled={pending}>
        {pending ? "ログアウト中…" : "ログアウト"}
      </button>
      {error && (
        <p role="alert" className="fog-error">
          {error}
        </p>
      )}
    </form>
  );
  const navigation = (
    <>
      <Link
        to="/timeline"
        className="fog-side-link"
        aria-current={
          pathname.startsWith("/timeline") || pathname.startsWith("/memos")
            ? "page"
            : undefined
        }
        onClick={() => dialog.current?.close()}
      >
        <span className="fog-nav-dot" />
        タイムライン
      </Link>
      <Link
        to="/topics"
        className="fog-side-link"
        aria-current={topicActive ? "page" : undefined}
        onClick={() => dialog.current?.close()}
      >
        <span className="fog-nav-dot" />
        トピック
      </Link>
      <Link
        to="/search"
        search={{ query: "" }}
        className="fog-side-link"
        aria-current={pathname === "/search" ? "page" : undefined}
        onClick={() => dialog.current?.close()}
      >
        <span className="fog-nav-dot" />
        検索
      </Link>
      <Link
        to="/trash"
        className="fog-side-link"
        aria-current={pathname === "/trash" ? "page" : undefined}
        onClick={() => dialog.current?.close()}
      >
        <span className="fog-nav-dot" />
        ゴミ箱
      </Link>
      <Link
        to="/settings"
        className="fog-side-link"
        aria-current={pathname === "/settings" ? "page" : undefined}
        onClick={() => dialog.current?.close()}
      >
        <span className="fog-nav-dot" />
        設定
      </Link>
    </>
  );
  return (
    <div className="fog-app">
      <a className="fog-skip" href="#main">
        本文へ移動
      </a>
      <aside className="fog-sidebar">
        <Link to="/timeline" aria-label="fog タイムライン">
          <Brand />
        </Link>
        <nav aria-label="メインナビゲーション">{navigation}</nav>
        {account}
      </aside>
      <div className="fog-main-column">
        <header className="fog-header">
          {backHref ? (
            <Link className="fog-back" to={backHref} aria-label="戻る">
              ←
            </Link>
          ) : (
            <div className="fog-mobile-brand">
              <Brand />
            </div>
          )}
          <h1>{title}</h1>
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
        <main id="main" className="fog-sheet">
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
        {account}
      </dialog>
    </div>
  );
}
