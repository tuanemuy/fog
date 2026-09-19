import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
// Server functions referenced only from client islands inside a streamed RSC
// payload are invisible to the production manifest unless a route module
// imports them ("Server function info not found" at runtime, dev is
// unaffected). These side-effect imports register them.
import "@/components/aiClients/actions";
import "@/components/auth/actions";
import "@/components/documents/actions";
import "@/components/memoHistory/actions";
import "@/components/search/actions";
import "@/components/settings/actions";
import "@/components/timeline/actions";
import "@/components/topics/actions";
import "@/components/trash/actions";
import type { ReactNode } from "react";
import { AuthSheet, AuthSheetRouteError } from "@/components/layout/AuthSheet";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { buildHead } from "@/presentation/head";
import appCss from "../styles/index.css?url";

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
    const { meta, links } = buildHead(config);
    return { meta, links: [...baseLinks, ...links] };
  },
  shellComponent: RootDocument,
  component: RootComponent,
  errorComponent: AuthSheetRouteError,
});

/**
 * A URL no route serves is answered here (`notFoundMode: "root"`), and the
 * root has no frame of its own: the router's default 404 is drawn on the auth
 * sheet. The root declares no not-found component — one here would also catch
 * a screen's `notFound()` and pull it out of the app shell (`router.tsx`).
 */
function RootComponent() {
  const unknownUrl = Route.useMatch({
    select: (match) => match.globalNotFound === true,
  });
  return unknownUrl ? (
    <AuthSheet>
      <Outlet />
    </AuthSheet>
  ) : (
    <Outlet />
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
