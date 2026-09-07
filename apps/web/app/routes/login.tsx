import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth/AuthForm";
import { readAuthStateFn } from "@/presentation/authState";
import { routeHead } from "@/presentation/head";
import {
  DEFAULT_REDIRECT_PATH,
  redirectSearchSchema,
} from "@/presentation/redirectSearch";

export const Route = createFileRoute("/login")({
  validateSearch: redirectSearchSchema,
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
  const { redirect: redirectTo } = Route.useSearch();
  return <AuthForm mode="login" redirectTo={redirectTo} />;
}
