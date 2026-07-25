import { z } from "zod";

/**
 * Transport-boundary schema for the `?redirect=` parameter that carries a
 * user back to the URL they were bounced off after signing in.
 *
 * The value comes from whoever wrote the URL, so it is constrained to a
 * same-origin path: `//evil.example` is a protocol-relative URL the browser
 * reads as another origin — an open redirector — and `/\evil.example` is
 * normalised to the same thing, so `//` and backslashes are refused.
 *
 * Same two-schema split as `pagination.ts`: strict for server-function
 * input, `catch`-wrapped for `validateSearch` so a hand-typed URL degrades
 * to "no redirect" instead of erroring the route.
 */
export const REDIRECT_MAX_LENGTH = 2048;

// Underscore-prefixed paths are the framework's own (`/_serverFn/...`).
// They are same-origin and would pass every other rule, but landing a
// signed-in user on a POST-only endpoint is a dead end, and fog has no
// public URL that starts with `_`.
const INTERNAL_PATH_PREFIX = "/_";

// A decoded CR/LF would be a header-injection attempt if any runtime ever
// accepted one in a `Location` value; refuse the whole C0/DEL range at the
// boundary rather than relying on the header implementation.
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const redirectPathSchema = z
  .string()
  .max(REDIRECT_MAX_LENGTH)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith(INTERNAL_PATH_PREFIX) &&
      !value.includes("//") &&
      !value.includes("\\") &&
      !value.startsWith("/%2f") &&
      !value.startsWith("/%2F") &&
      !hasControlCharacter(value),
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
