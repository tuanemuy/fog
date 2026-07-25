import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { SignupForm } from "@/components/auth/SignupForm";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { buildHead } from "@/presentation/head";
import { DEFAULT_REDIRECT_PATH } from "@/presentation/redirectSearch";

const readAuthStateFn = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { getCurrentUserId } = await import("@/presentation/currentUser");
    return { authenticated: (await getCurrentUserId()) !== null };
  });

export const Route = createFileRoute("/signup")({
  // Signup takes no `?redirect=`, so an already-signed-in visitor goes home.
  beforeLoad: async () => {
    const { authenticated } = await readAuthStateFn();
    if (authenticated) throw redirect({ to: DEFAULT_REDIRECT_PATH });
  },
  head: ({ match }) => {
    const config = match.context.config;
    if (!config) return {};
    return {
      meta: buildHead(config, { title: "アカウント登録", path: "/signup" })
        .meta,
    };
  },
  component: SignupPage,
});

function SignupPage() {
  return (
    <AuthSheet title="アカウント登録">
      <SignupForm />
    </AuthSheet>
  );
}
