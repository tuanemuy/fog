import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { Button } from "@/components/ui/Button";
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
    const { meta, links } = buildHead(config);
    return { meta, links: [...baseLinks, ...links] };
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
 * The last-resort failure surface (spec/pages/index.md 共通レイアウト: 通信
 * エラーはリトライ導線付きで扱う). `invalidate()` re-runs the loaders that
 * failed, so a transient failure recovers without a full page load.
 */
const ERROR_TITLE = "エラーが発生しました";

function ErrorScreen({ message }: { message: string }) {
  const router = useRouter();
  return (
    <AuthSheet
      title={ERROR_TITLE}
      // The generic fallback message is the heading itself; repeating it
      // under the heading says nothing.
      {...(message === ERROR_TITLE ? {} : { description: message })}
    >
      <div className="flex flex-col gap-lg">
        <Button type="button" fullWidth onClick={() => router.invalidate()}>
          再読み込み
        </Button>
        <p className="text-center text-sm">
          <TextLink to="/">タイムラインへ</TextLink>
        </p>
      </div>
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
