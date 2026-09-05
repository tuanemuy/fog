import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "@/components/fog/AuthForm";
import { loadFogAccountOptions } from "@/presentation/fogAccountActions";
import { loadFogSession } from "@/presentation/fogActions";
import { safeReturnTo } from "@/presentation/fogSecurity";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: safeReturnTo(search.returnTo),
    ...(typeof search.auth === "string" ? { auth: search.auth } : {}),
  }),
  beforeLoad: async ({ search }) => {
    if (await loadFogSession({ data: {} }))
      throw redirect({ href: search.returnTo });
  },
  loader: () => loadFogAccountOptions({ data: {} }),
  head: () => ({ meta: [{ title: "ログイン — fog" }] }),
  component: Page,
});

function Page() {
  const { returnTo, auth } = Route.useSearch();
  const { googleEnabled } = Route.useLoaderData();
  return (
    <AuthForm
      mode="login"
      returnTo={returnTo}
      googleEnabled={googleEnabled}
      status={auth}
    />
  );
}
