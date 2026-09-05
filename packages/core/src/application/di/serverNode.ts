import { content } from "@repo/core/config";
import { z } from "zod";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import type { AppConfig, RequestContainer } from "./types";

const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "APP_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
const nodeServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  DATABASE_ENCRYPTION_KEY: z.string().min(1).optional(),
  APP_URL: origin,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOSTNAME: z.string().min(1).default("127.0.0.1"),
});
export type NodeServerEnv = z.infer<typeof nodeServerEnvSchema>;
export function readNodeServerEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeServerEnv {
  return nodeServerEnvSchema.parse(source);
}
export function readNodeRequestServerConfig(env: NodeServerEnv): AppConfig {
  return { ...content, appUrl: new URL(env.APP_URL).origin };
}
export function createNodeRequestContainer(
  config: AppConfig,
): RequestContainer {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    config,
  };
}
