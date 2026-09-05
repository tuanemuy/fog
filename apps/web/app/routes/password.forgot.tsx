import { createFileRoute } from "@tanstack/react-router";
import { PasswordRecoveryForm } from "@/components/fog/PasswordRecoveryForm";
export const Route = createFileRoute("/password/forgot")({
  head: () => ({
    meta: [
      { title: "パスワードを忘れた方 — fog" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: () => <PasswordRecoveryForm />,
});
