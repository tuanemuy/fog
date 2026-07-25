import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { LoginForm } from "@/components/auth/LoginForm";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { buildHead } from "@/presentation/head";
import {
  DEFAULT_REDIRECT_PATH,
  redirectSearchSchema,
} from "@/presentation/redirectSearch";

const readAuthStateFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { getCurrentUserId } = await import("@/presentation/currentUser");
    return { authenticated: (await getCurrentUserId()) !== null };
  });

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
