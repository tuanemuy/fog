import "@/presentation/fogAccountViews";
import "@/presentation/fogAccountActions";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { buildHead } from "@/presentation/head";
import appCss from "../styles/index.css?url";

import "@/presentation/fogActions";
import "@/presentation/fogDataActions";
import "@/presentation/fogAiActions";
import "@/presentation/fogDocumentActions";
import "@/presentation/fogMemoActions";

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
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
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
  component: RootComponent,
  errorComponent: ({ error }) => (
    <RootDocument>
      <div>
        <h1>エラーが発生しました</h1>
        <pre>{sanitizeRouteError(error)}</pre>
      </div>
    </RootDocument>
  ),
  notFoundComponent: () => (
    <RootDocument>
      <div>
        <h1>ページが見つかりません</h1>
      </div>
    </RootDocument>
  ),
});

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
