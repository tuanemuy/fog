import { createFileRoute } from "@tanstack/react-router";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { TextLink } from "@/components/ui/TextLink";
import { routeHead } from "@/presentation/head";

export const Route = createFileRoute("/password-reset")({
  head: ({ match }) =>
    routeHead(match, {
      title: "パスワードリセット",
      path: "/password-reset",
    }),
  component: PasswordResetPage,
});

// Placeholder: the link from /login has to go somewhere, and a page that
// states its own status beats a dead control.
function PasswordResetPage() {
  return (
    <AuthSheet title="パスワードリセット" description="この機能は準備中です">
      <div className="text-center text-sm">
        <TextLink to="/login">ログインに戻る</TextLink>
      </div>
    </AuthSheet>
  );
}
