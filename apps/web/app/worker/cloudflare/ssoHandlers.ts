import {
  decodeDevCode,
  encodeDevCode,
} from "@repo/core/adapters/sso/devStubSsoProvider";
import type { SsoStatePayload } from "@repo/core/adapters/webcrypto/ssoStateCodec";
import {
  createRequestContainer,
  createSsoRuntime,
  readRequestServerConfig,
  type ServerEnv,
  type SsoRuntime,
} from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  isConflictError,
  isSystemError,
  isValidationError,
} from "@repo/core/application/errors";
import { toSafeRedirect } from "@/presentation/redirectSearch";
import {
  buildSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/presentation/sessionCookie";

export const SSO_STATE_COOKIE_NAME = "fog_sso_state";
const SSO_STATE_COOKIE_MAX_AGE_SECONDS = 600;
const SSO_PATH = /^\/auth\/sso\/([a-z]+)\/(start|callback)$/;
const DEV_PATH = /^\/__dev\/sso\/([a-z]+)\/authorize$/;

/** `sso_error` values the screens render (P-01 / P-02 / P-13). */
export type SsoErrorCode =
  | "email_registered"
  | "already_used"
  | "cancelled"
  | "unverified"
  | "failed";

export function isSsoRoute(pathname: string): boolean {
  return SSO_PATH.test(pathname) || DEV_PATH.test(pathname);
}

/**
 * The bare SSO handlers (design D-07). They run outside TanStack, so
 * every outcome travels as a redirect with a query parameter (△-6):
 * `start` signs the state, pins it in a cookie and bounces to the
 * provider; `callback` checks cookie and signature, exchanges the code,
 * runs the usecase and starts the session; the `__dev` page is the stub
 * provider's consent screen and exists only with `SSO_DEV_STUB="true"`.
 */
export async function handleSso(
  request: Request,
  env: ServerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const config = readRequestServerConfig(env);
  const container = createRequestContainer(config);
  const runtime = createSsoRuntime(env, config);
  const secure = new URL(config.appUrl).protocol === "https:";

  const dev = DEV_PATH.exec(url.pathname);
  if (dev !== null) {
    if (!runtime.devStubEnabled) return notFound();
    return handleDevAuthorize(request, url, dev[1] ?? "");
  }
  const match = SSO_PATH.exec(url.pathname);
  if (match === null) return notFound();
  const provider = match[1] ?? "";
  // A name with no adapter behind it is not a route, whatever the intent.
  if (!(runtime.providers as readonly string[]).includes(provider)) {
    return notFound();
  }
  if (match[2] === "start") {
    return handleStart(request, url, provider, container, runtime, secure);
  }
  return handleCallback(request, url, provider, container, runtime, secure);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function redirectTo(
  location: string,
  cookies: readonly string[] = [],
): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function withError(path: string, code: SsoErrorCode): string {
  const url = new URL(path, "http://placeholder");
  url.searchParams.set("sso_error", code);
  return `${url.pathname}${url.search}`;
}

function stateCookie(value: string | null, secure: boolean): string {
  const parts = [
    `${SSO_STATE_COOKIE_NAME}=${value === null ? "" : encodeURIComponent(value)}`,
    "Path=/auth/sso",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${value === null ? 0 : SSO_STATE_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The session check of `presentation/currentUser.ts`, on a raw request. */
async function readSessionUserId(
  request: Request,
  container: RequestContainer,
): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (token === null) return null;
  const verified = await container.sessionCodec.verify(
    token,
    container.clock.now(),
  );
  if (verified === null) return null;
  let account: Awaited<
    ReturnType<typeof container.identityGateway.readAccountState>
  >;
  try {
    account = await container.identityGateway.readAccountState(verified.userId);
  } catch (error) {
    if (isSystemError(error) && error.code === "NOT_INITIALIZED") return null;
    throw error;
  }
  if (account === null || account.status !== "active") return null;
  if (account.sessionEpoch > verified.sessionEpoch) return null;
  return verified.userId;
}

async function handleStart(
  request: Request,
  url: URL,
  provider: string,
  container: RequestContainer,
  runtime: SsoRuntime,
  secure: boolean,
): Promise<Response> {
  const intent = url.searchParams.get("intent") === "link" ? "link" : "login";
  const origin =
    intent === "link"
      ? "/settings"
      : url.searchParams.get("from") === "signup"
        ? "/signup"
        : "/login";
  let userId: string | null = null;
  if (intent === "link") {
    userId = await readSessionUserId(request, container);
    if (userId === null) {
      return redirectTo("/login?redirect=%2Fsettings");
    }
  }
  const payload: SsoStatePayload = {
    provider,
    intent,
    redirect:
      toSafeRedirect(url.searchParams.get("redirect") ?? undefined) ?? null,
    origin,
    userId,
  };
  let location: string;
  try {
    const state = await runtime.stateCodec.issue(
      payload,
      container.clock.now(),
    );
    location = runtime.provider.buildAuthorizationUrl(
      // The value object is rebuilt by the usecase; here the name only
      // selects the adapter, and an unknown one is refused by it.
      provider as Parameters<typeof runtime.provider.buildAuthorizationUrl>[0],
      state,
    );
    return redirectTo(location, [stateCookie(state, secure)]);
  } catch (error) {
    container.logger.error("SSO start failed", {
      provider,
      cause: error instanceof Error ? error.name : "unknown",
    });
    return redirectTo(withError(origin, "failed"));
  }
}

async function handleCallback(
  request: Request,
  url: URL,
  provider: string,
  container: RequestContainer,
  runtime: SsoRuntime,
  secure: boolean,
): Promise<Response> {
  const clear = stateCookie(null, secure);
  const presented = url.searchParams.get("state") ?? "";
  const pinned = readCookie(request, SSO_STATE_COOKIE_NAME);
  const payload =
    pinned !== null && pinned === presented
      ? await runtime.stateCodec.verify(presented, container.clock.now())
      : null;
  if (payload === null || payload.provider !== provider) {
    return redirectTo(withError("/login", "failed"), [clear]);
  }
  const origin = payload.origin;
  const providerError = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (providerError !== null || code === null) {
    return redirectTo(withError(origin, "cancelled"), [clear]);
  }
  try {
    const assertion = await runtime.provider.exchangeCode(
      provider as Parameters<typeof runtime.provider.exchangeCode>[0],
      code,
    );
    if (assertion === "cancelled") {
      return redirectTo(withError(origin, "cancelled"), [clear]);
    }
    if (payload.intent === "link") {
      const userId = await readSessionUserId(request, container);
      if (userId === null || userId !== payload.userId) {
        return redirectTo("/login?redirect=%2Fsettings", [clear]);
      }
      const { linkSsoCredential } = await import(
        "@repo/core/application/identity/linkSsoCredential"
      );
      await linkSsoCredential({
        container,
        input: {
          userId,
          provider,
          providerSubject: assertion.providerSubject,
        },
      });
      return redirectTo("/settings?sso=linked", [clear]);
    }
    const { registerOrLoginWithSso } = await import(
      "@repo/core/application/identity/registerOrLoginWithSso"
    );
    const { userId } = await registerOrLoginWithSso({
      container,
      input: {
        provider,
        providerSubject: assertion.providerSubject,
        email: assertion.email,
      },
    });
    const account = await container.identityGateway.readAccountState(userId);
    if (account === null) {
      return redirectTo(withError(origin, "failed"), [clear]);
    }
    const token = await container.sessionCodec.issue(
      userId,
      account.sessionEpoch,
      container.clock.now(),
    );
    return redirectTo(payload.redirect ?? "/", [
      clear,
      buildSessionCookie(token, { secure }),
    ]);
  } catch (error) {
    return redirectTo(withError(origin, classifyFailure(error, payload)), [
      clear,
    ]);
  }
}

function classifyFailure(
  error: unknown,
  payload: SsoStatePayload,
): SsoErrorCode {
  if (isConflictError(error)) {
    if (error.code === "EMAIL_ALREADY_REGISTERED") return "email_registered";
    return "already_used";
  }
  if (isValidationError(error) && error.code === "SSO_EMAIL_UNVERIFIED") {
    return "unverified";
  }
  void payload;
  return "failed";
}

/** The stub provider's consent page: a subject and an address, 許可 or キャンセル. */
async function handleDevAuthorize(
  request: Request,
  url: URL,
  provider: string,
): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const callback = new URL(`/auth/sso/${provider}/callback`, url.origin);
  callback.searchParams.set("state", state);
  if (request.method === "POST") {
    const form = await request.formData();
    if (form.get("decision") !== "allow") {
      callback.searchParams.set("error", "access_denied");
      return redirectTo(callback.toString());
    }
    const providerSubject = String(form.get("subject") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    if (providerSubject.length === 0 || email.length === 0) {
      return new Response(
        devPage(provider, state, "subject と email を入力してください"),
        {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
    const decoded = decodeDevCode(encodeDevCode({ providerSubject, email }));
    callback.searchParams.set(
      "code",
      encodeDevCode(decoded ?? { providerSubject, email }),
    );
    return redirectTo(callback.toString());
  }
  return new Response(devPage(provider, state, null), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function devPage(
  provider: string,
  state: string,
  error: string | null,
): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Dev SSO (${escapeHtml(provider)})</title>
<style>body{font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}label{display:block;margin:.75rem 0 .25rem}input{width:100%;padding:.5rem}button{margin:1rem .5rem 0 0;padding:.5rem 1rem}.err{color:#b00}</style>
</head><body>
<h1>開発用 SSO スタブ（${escapeHtml(provider)}）</h1>
<p>本物の IdP の代わりです。subject と email を入力して「許可」を押すと、その主体としてコールバックされます。</p>
${error === null ? "" : `<p class="err" role="alert">${escapeHtml(error)}</p>`}
<form method="post">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<label for="subject">subject</label><input id="subject" name="subject" value="dev-subject-1" required>
<label for="email">email</label><input id="email" name="email" type="email" value="sso-user@example.com" required>
<button type="submit" name="decision" value="allow">許可</button>
<button type="submit" name="decision" value="deny">キャンセル</button>
</form></body></html>`;
}
