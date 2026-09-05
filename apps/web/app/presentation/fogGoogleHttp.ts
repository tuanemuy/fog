import type { FogServices } from "@repo/core/application/fog/types";
import { z } from "zod";
import { extractSerializedError } from "./errorResponse";
import { assertHumanTransport, safeReturnTo } from "./fogSecurity";
import { validateInput } from "./validator";

const input = z
  .object({
    state: z.string().min(1).max(256),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(100).optional(),
  })
  .refine((x) => Boolean(x.code) !== Boolean(x.error));
function cookie(request: Request, name: string) {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
export async function handleFogGoogleCallback(
  request: Request,
  { services, appUrl }: { services: FogServices; appUrl: string },
): Promise<Response> {
  if (request.headers.has("authorization"))
    return new Response("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  const redirect = (path: string) => {
    headers.set("Location", new URL(path, appUrl).href);
    return new Response(null, { status: 303, headers });
  };
  let signedIn = false;
  try {
    assertHumanTransport(request);
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405, headers });
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some(
        (k) => url.searchParams.getAll(k).length !== 1,
      )
    )
      throw new Error("Duplicate callback parameter");
    const parsed = validateInput(input)(Object.fromEntries(url.searchParams));
    const actor = await services.authenticate(cookie(request, "fog_session"));
    signedIn = !!actor;
    const result = await services.completeGoogleAuth(actor, {
      state: parsed.state,
      browserToken: cookie(request, "fog_oidc_browser") ?? "",
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
    });
    if (result.kind === "signedIn") {
      headers.append(
        "Set-Cookie",
        `fog_session=${encodeURIComponent(result.auth.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(appUrl).protocol === "https:" ? "; Secure" : ""}`,
      );
      return redirect(safeReturnTo(result.returnTo));
    }
    if (result.kind === "linked") return redirect("/settings?auth=linked");
    return redirect(
      signedIn
        ? "/settings?auth=cancelled"
        : `/login?auth=cancelled&returnTo=${encodeURIComponent(safeReturnTo(result.returnTo))}`,
    );
  } catch (error) {
    const code = extractSerializedError(error).code;
    const status =
      code === "EMAIL_EXISTS"
        ? "email-exists"
        : code === "GOOGLE_CREDENTIAL_EXISTS"
          ? "already-linked"
          : "failed";
    return redirect(
      signedIn ? `/settings?auth=${status}` : `/login?auth=${status}`,
    );
  }
}
