import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { ERROR_TITLE, ErrorRetry } from "@/components/ui/ErrorRetry";
import { TextLink } from "@/components/ui/TextLink";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { buildHead } from "@/presentation/head";
import appCss from "../styles/index.css?url";

// Server fns only reachable from `"use client"` components miss the
// rsc manifest (frozen before the client build phase). Pull their
// provider modules into a server-rendered route to register them.
import "@/components/auth/LoginForm/action";
import "@/components/auth/SignupForm/action";
import "@/components/settings/LogoutButton/action";

export const loadAppContext = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { getContainer } = await import(
      "@repo/core/application/di/containerStore"
    );
    const container = await getContainer();
    return { config: container.config };
  });

const SITE_ASSET_LINKS = [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
];

export const Route = createRootRoute({
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  beforeLoad: () => loadAppContext(),
  head: ({ match }) => {
    const stylesheet = { rel: "stylesheet", href: appCss };
    const baseLinks = [...SITE_ASSET_LINKS, stylesheet];
    const config = match.context?.config;
    if (!config) return { links: baseLinks };
    // `meta` only: matches override each other by `name` / `property`, but
    // `links` from every match are concatenated as-is, so a canonical here
    // would sit beside the page's own rather than be replaced by it. Each
    // route owns its canonical through `routeHead`.
    const { meta } = buildHead(config);
    return { meta, links: baseLinks };
  },
  component: RootComponent,
  errorComponent: ({ error }) => (
    <RootDocument>
      <ErrorScreen message={sanitizeRouteError(error)} />
    </RootDocument>
  ),
  notFoundComponent: () => (
    <RootDocument>
      <AuthSheet
        title="ページが見つかりません"
        description="URL が変わったか、削除された可能性があります"
      >
        <p className="text-center text-sm">
          <TextLink to="/">タイムラインへ</TextLink>
        </p>
      </AuthSheet>
    </RootDocument>
  ),
});

/**
 * The last-resort failure surface: a full-screen sheet with no navigation,
 * for failures outside the signed-in shell — the pre-auth screens, and a
 * failure of the root's own `beforeLoad` (`loadAppContext`). A match's
 * `errorComponent` handles that match's own `beforeLoad` / `loader`, so
 * `_app` catches its own failures too; everything under the shell is caught
 * one level lower by `_app`'s `errorComponent`, which keeps the global nav
 * (.issue/1/adr.md ADR-048).
 */
function ErrorScreen({ message }: { message: string }) {
  return (
    <AuthSheet
      title={ERROR_TITLE}
      // The generic fallback message is the heading itself; repeating it
      // under the heading says nothing.
      {...(message === ERROR_TITLE ? {} : { description: message })}
    >
      <ErrorRetry fullWidth />
    </AuthSheet>
  );
}

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
        <Scripts />
      </body>
    </html>
  );
}
