import { getContainer } from "@repo/core/application/di/containerStore";
import {
  ForbiddenError,
  UnauthorizedError,
} from "@repo/core/application/errors";
import { getFogServices } from "@repo/core/application/fog/runtime";
import {
  deleteCookie,
  getCookie,
  getRequest,
  setCookie,
} from "@tanstack/react-start/server";
import { assertHumanTransport, isSameOriginMutation } from "./fogSecurity";

const SESSION_COOKIE = "fog_session";

export async function assertFogMutation() {
  assertHumanTransport(getRequest());
  const { config } = await getContainer();
  if (!isSameOriginMutation(getRequest(), config.appUrl))
    throw new ForbiddenError(
      "CROSS_ORIGIN_REQUEST",
      "この操作は許可されていません",
    );
}

export async function getFogSession() {
  assertHumanTransport(getRequest());
  return (await getFogServices()).authenticate(getCookie(SESSION_COOKIE));
}

export async function requireFogActor() {
  const actor = await getFogSession();
  if (!actor)
    throw new UnauthorizedError("SESSION_REQUIRED", "ログインしてください");
  return actor;
}

export async function setFogSession(token: string) {
  const { config } = await getContainer();
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(config.appUrl).protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearFogSession() {
  await (await getFogServices()).logout(getCookie(SESSION_COOKIE));
  deleteCookie(SESSION_COOKIE, { path: "/" });
}
