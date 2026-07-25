import type { AppConfig } from "@repo/core/application/di/types";

export const content: Omit<AppConfig, "appUrl"> = {
  siteName: "fog",
  defaultTitle: "fog",
  defaultDescription:
    "雑に書き留めたメモを、AI が紡いでドキュメントに変えるメモアプリ。",
  themeColor: "#ffffff",
  // twitterHandle: "@example",
};
