import { z } from "zod";

/**
 * Transport-boundary schema for the `?redirect=` parameter that carries a
 * user back to the URL they were bounced off after signing in.
 *
 * The value comes from whoever wrote the URL, so it is constrained to a
 * same-origin path: it must start with `/` and must not contain `//`,
 * which is what stops `?redirect=//evil.example` (a protocol-relative URL
 * the browser reads as another origin) from turning the login screen into
 * an open redirector. Backslashes are refused for the same reason —
 * browsers normalise `/\evil.example` to `//evil.example`.
 *
 * Same two-schema split as `pagination.ts`: the strict variant guards
 * values handed to a server function, and the `catch`-wrapped variant is
 * for `validateSearch` so a hand-typed URL degrades to "no redirect"
 * instead of erroring the route.
 */
export const REDIRECT_MAX_LENGTH = 2048;

export const redirectPathSchema = z
  .string()
  .max(REDIRECT_MAX_LENGTH)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes("//") &&
      !value.includes("\\") &&
      !value.startsWith("/%2f") &&
      !value.startsWith("/%2F"),
    { message: "リダイレクト先が不正です" },
  );

export const redirectSearchSchema = z.object({
  redirect: redirectPathSchema.optional().catch(undefined),
});

export type RedirectSearch = z.infer<typeof redirectSearchSchema>;

export const DEFAULT_REDIRECT_PATH = "/";

/** Narrows an arbitrary path to one that is safe to navigate to. */
export function toSafeRedirect(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = redirectPathSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
