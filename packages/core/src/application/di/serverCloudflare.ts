import { content } from "@repo/core/config";
import {
  isSecureRemoteLibsqlUrl,
  remoteLibsqlIdentity,
} from "@repo/core/lib/remoteLibsql";
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
  }, "APP_URL must be an HTTP(S) origin");

const schema = z.object({
  DATABASE_URL: z
    .string()
    .trim()
    .refine(
      isSecureRemoteLibsqlUrl,
      "DATABASE_URL must use secure remote libSQL",
    ),
  DATABASE_AUTH_TOKEN: z.string().trim().min(1),
  DATABASE_ENCRYPTION_KEY: z.undefined().optional(),
  APP_URL: origin,
  DEPLOYMENT_SHA: z
    .string()
    .regex(
      /^[0-9a-f]{40}$/,
      "DEPLOYMENT_SHA must be a full lowercase commit SHA",
    ),
  DEPLOYMENT_ENV: z.enum(["staging", "production"]),
  EXPECTED_DATABASE_IDENTITY: z.string().trim().min(1),
  FOG_GOOGLE_CALLBACK_URL: z.string().url(),
  FOG_AI_CLIENTS: z.string().optional(),
  FOG_GOOGLE_CLIENT_ID: z.string().trim().min(1),
  FOG_GOOGLE_CLIENT_SECRET: z.string().trim().min(1),
  FOG_EMAIL_FROM: z.string().email().max(254),
});

export type CloudflareServerEnv = z.infer<typeof schema>;

export function readCloudflareServerEnv(
  source: Readonly<Record<string, unknown>>,
): CloudflareServerEnv {
  const env = schema.parse(source);
  const expectedDatabasePrefix =
    env.DEPLOYMENT_ENV === "staging" ? "fog-staging" : "fog-production";
  const databaseLabel = new URL(
    `libsql://${env.EXPECTED_DATABASE_IDENTITY}`,
  ).hostname.split(".")[0];
  if (
    databaseLabel !== expectedDatabasePrefix &&
    !databaseLabel.startsWith(`${expectedDatabasePrefix}-`)
  )
    throw new Error("Database identity does not match DEPLOYMENT_ENV");
  if (remoteLibsqlIdentity(env.DATABASE_URL) !== env.EXPECTED_DATABASE_IDENTITY)
    throw new Error("DATABASE_URL does not match the selected stage database");
  const appUrl = new URL(env.APP_URL);
  const expectedPrefix =
    env.DEPLOYMENT_ENV === "staging" ? "staging-fog." : "fog.";
  if (
    appUrl.protocol !== "https:" ||
    !appUrl.hostname.startsWith(expectedPrefix)
  )
    throw new Error("APP_URL does not match DEPLOYMENT_ENV");
  const domain = appUrl.hostname.slice(expectedPrefix.length);
  const expectedSender = `${env.DEPLOYMENT_ENV === "staging" ? "fog-staging" : "fog"}@${domain}`;
  if (env.FOG_EMAIL_FROM !== expectedSender)
    throw new Error("FOG_EMAIL_FROM does not match DEPLOYMENT_ENV");
  if (
    env.FOG_GOOGLE_CALLBACK_URL !==
    new URL("/auth/google/callback", appUrl).href
  )
    throw new Error("Google callback URL does not match APP_URL");
  return env;
}

export function readCloudflareRequestServerConfig(
  env: CloudflareServerEnv,
): AppConfig {
  return { ...content, appUrl: new URL(env.APP_URL).origin };
}

export function createCloudflareRequestContainer(
  config: AppConfig,
): RequestContainer {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    config,
  };
}
