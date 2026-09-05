import { z } from "zod";

const optional = z.string().min(1).optional();
const schema = z.object({
  FOG_GOOGLE_CLIENT_ID: optional,
  FOG_GOOGLE_CLIENT_SECRET: optional,
  FOG_OIDC_FIXTURE_ORIGIN: z.string().url().optional(),
  FOG_SMTP_HOST: optional,
  FOG_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  FOG_SMTP_FROM: z
    .string()
    .max(254)
    .refine((v) => !/[\r\n]/.test(v))
    .optional(),
  FOG_SMTP_USER: optional,
  FOG_SMTP_PASSWORD: optional,
  FOG_SMTP_LOCAL: z.enum(["true", "false"]).default("false"),
});
export function readFogAccountConfig(
  env: Record<string, string | undefined>,
  appUrl: string,
) {
  const input = schema.parse(env);
  const app = new URL(appUrl);
  const loopback = (url: URL) =>
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password;
  if (
    input.FOG_OIDC_FIXTURE_ORIGIN &&
    (!loopback(app) || !loopback(new URL(input.FOG_OIDC_FIXTURE_ORIGIN)))
  )
    throw new Error("OIDC fixture requires loopback URLs");
  if (
    input.FOG_SMTP_LOCAL === "true" &&
    (!loopback(app) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(input.FOG_SMTP_HOST ?? ""))
  )
    throw new Error("SMTP fixture requires loopback URLs");
  if (!!input.FOG_GOOGLE_CLIENT_ID !== !!input.FOG_GOOGLE_CLIENT_SECRET)
    throw new Error("Google client ID and secret must be set together");
  if (!!input.FOG_SMTP_USER !== !!input.FOG_SMTP_PASSWORD)
    throw new Error("SMTP credentials must be set together");
  if (input.FOG_SMTP_HOST && !input.FOG_SMTP_FROM)
    throw new Error("SMTP sender must be configured");
  return input;
}
