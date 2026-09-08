import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth/AuthForm";
import { ssoErrorSchema } from "@/components/auth/schema";
import { readAuthStateFn } from "@/presentation/authState";
import { routeHead } from "@/presentation/head";
import {
  DEFAULT_REDIRECT_PATH,
  redirectSearchSchema,
} from "@/presentation/redirectSearch";

export const Route = createFileRoute("/login")({
  validateSearch: redirectSearchSchema.extend({
    sso_error: ssoErrorSchema.optional(),
  }),
  beforeLoad: async ({ search }) => {
    const { authenticated } = await readAuthStateFn();
    if (authenticated) {
      throw redirect({ href: search.redirect ?? DEFAULT_REDIRECT_PATH });
    }
  },
  head: ({ match }) =>
    routeHead(match, { title: "ログイン — fog", path: "/login" }),
  component: LoginPage,
});

function LoginPage() {
  const { redirect: redirectTo, sso_error: ssoError } = Route.useSearch();
  const { config } = Route.useRouteContext();
  return (
    <AuthForm
      mode="login"
      redirectTo={redirectTo}
      ssoError={ssoError}
      ssoProviders={config.ssoProviders}
    />
  );
}
