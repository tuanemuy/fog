import type { AppConfig } from "@repo/core/application/di/types";

export const content: Omit<AppConfig, "appUrl"> = {
  siteName: "fog",
  defaultTitle: "fog",
  defaultDescription: "気軽に残したメモを、AIと育てる。",
  themeColor: "#ffffff",
};
