import type { AppConfig } from "@repo/core/application/di/types";

// 1200x630 — `summary_large_image` 互換サイズ。
const DEFAULT_OG_IMAGE_PATH = "/og-image.png";
const DEFAULT_LOCALE = "ja_JP";

export type HeadOverrides = Readonly<{
  title?: string;
  description?: string;
  path?: string;
  ogImage?: string;
  ogType?: "website" | "article";
}>;

type MetaTag =
  | { charSet: string }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

type LinkTag = { rel: string; href: string };

// TanStack Router の `head()` 戻り値型が mutable array を要求するため readonly 不可。
export type HeadConfig = {
  meta: MetaTag[];
  links: LinkTag[];
};

function isAbsoluteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function joinUrl(appUrl: string, pathOrUrl: string): string {
  if (isAbsoluteUrl(pathOrUrl)) return pathOrUrl;
  const base = appUrl.replace(/\/$/, "");
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}

export function buildHead(
  config: AppConfig,
  overrides: HeadOverrides = {},
): HeadConfig {
  const title = overrides.title ?? config.defaultTitle;
  const description = overrides.description ?? config.defaultDescription;
  const ogType = overrides.ogType ?? "website";
  const url = joinUrl(config.appUrl, overrides.path ?? "/");
  const ogImage = joinUrl(
    config.appUrl,
    overrides.ogImage ?? DEFAULT_OG_IMAGE_PATH,
  );

  const meta: MetaTag[] = [
    { charSet: "utf-8" },
    // `viewport-fit=cover` is what makes `env(safe-area-inset-*)` resolve to
    // anything but 0 — without it the safe-area tokens in `tokens.css` are
    // inert and content sits under the notch / home indicator when the app
    // is launched standalone.
    {
      name: "viewport",
      content: "width=device-width, initial-scale=1, viewport-fit=cover",
    },
    { title },
    { name: "description", content: description },
    { name: "theme-color", content: config.themeColor },
    { name: "format-detection", content: "telephone=no" },
    { name: "mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-status-bar-style", content: "default" },
    { name: "apple-mobile-web-app-title", content: config.siteName },
    { property: "og:type", content: ogType },
    { property: "og:url", content: url },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:image", content: ogImage },
    { property: "og:site_name", content: config.siteName },
    { property: "og:locale", content: DEFAULT_LOCALE },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: ogImage },
  ];
  if (config.twitterHandle !== undefined) {
    meta.push({ name: "twitter:site", content: config.twitterHandle });
  }

  const links: LinkTag[] = [{ rel: "canonical", href: url }];

  return { meta, links };
}

// `config` is absent only while the root `beforeLoad` that provides it is
// still in flight; there is nothing page-specific to say yet.
type RouteHeadMatch = { context: { config?: AppConfig | undefined } };

/**
 * The per-route `head()` body.
 *
 * Returning `meta` alone leaves `__root`'s canonical (the home page) in
 * place, which then contradicts the page's own `og:url` — the two are built
 * from the same `path`, so they are returned together or not at all.
 */
export function routeHead(
  match: RouteHeadMatch,
  overrides: HeadOverrides = {},
): Partial<HeadConfig> {
  const config = match.context.config;
  if (!config) return {};
  const { meta, links } = buildHead(config, overrides);
  return { meta, links };
}
