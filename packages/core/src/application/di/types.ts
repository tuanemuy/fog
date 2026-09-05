import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger } from "../ports/logger";

export type AppConfig = Readonly<{
  appUrl: string;
  siteName: string;
  defaultTitle: string;
  defaultDescription: string;
  twitterHandle?: string;
  themeColor: string;
}>;
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
}>;
/** Per-request presentation context; fog usecases receive their own transactional ports. */
export type RequestContainer = SharedDeps & Readonly<{ config: AppConfig }>;
