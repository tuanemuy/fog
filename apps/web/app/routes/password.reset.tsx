import { createFileRoute } from "@tanstack/react-router";
import { PasswordRecoveryForm } from "@/components/fog/PasswordRecoveryForm";
export const Route = createFileRoute("/password/reset")({
  validateSearch: (search: Record<string, unknown>) => ({
    token:
      typeof search.token === "string" && search.token.length <= 256
        ? search.token
        : "",
  }),
  head: () => ({
    meta: [
      { title: "パスワードの再設定 — fog" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: Page,
});
function Page() {
  const { token } = Route.useSearch();
  return <PasswordRecoveryForm token={token} />;
}
