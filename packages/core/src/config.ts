import type { AppConfig } from "@repo/core/application/di/types";

/** Site-wide constants; `appUrl` comes from the Worker's config at request time. */
export const content = {
  siteName: "fog",
  defaultTitle: "fog",
  defaultDescription: "雑に記録し、AIが整理するメモアプリ。",
  themeColor: "#f4f4f6",
} as const satisfies Omit<AppConfig, "appUrl">;
