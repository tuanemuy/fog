import { ForbiddenError } from "@repo/core/application/errors";

export function assertHumanTransport(request: Request): void {
  if (request.headers.has("authorization"))
    throw new ForbiddenError(
      "HUMAN_SESSION_ONLY",
      "人間用の画面ではAIの認証情報を使用できません。",
    );
}

export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    Array.from(value).some(
      (character) =>
        character === "\\" ||
        character.charCodeAt(0) <= 32 ||
        character.charCodeAt(0) === 127,
    )
  )
    return "/timeline";
  try {
    const base = "https://fog.invalid";
    const url = new URL(value, base);
    if (
      url.origin !== base ||
      ["/login", "/signup", "/"].includes(url.pathname)
    )
      return "/timeline";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/timeline";
  }
}

export function isSameOriginMutation(
  request: Request,
  appUrl: string,
): boolean {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || origin === null)
    return false;
  return origin === new URL(appUrl).origin;
}
