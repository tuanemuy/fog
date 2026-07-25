import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginForm } from "@/components/auth/LoginForm";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { readAuthStateFn } from "@/presentation/authState";
import { buildHead } from "@/presentation/head";
import {
  DEFAULT_REDIRECT_PATH,
  redirectSearchSchema,
} from "@/presentation/redirectSearch";

export const Route = createFileRoute("/login")({
  validateSearch: redirectSearchSchema,
  // Already signed in: send them where they were headed rather than
  // dropping the `?redirect=` they arrived with.
  beforeLoad: async ({ search }) => {
    const { authenticated } = await readAuthStateFn();
    if (authenticated) {
      throw redirect({ href: search.redirect ?? DEFAULT_REDIRECT_PATH });
    }
  },
  head: ({ match }) => {
    const config = match.context.config;
    if (!config) return {};
    return {
      meta: buildHead(config, { title: "ログイン", path: "/login" }).meta,
    };
  },
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  return (
    <AuthSheet title="ログイン">
      <LoginForm redirectTo={search.redirect ?? DEFAULT_REDIRECT_PATH} />
    </AuthSheet>
  );
}
