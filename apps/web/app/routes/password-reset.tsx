import { createFileRoute } from "@tanstack/react-router";
import { AuthSheet } from "@/components/ui/AuthSheet";
import { TextLink } from "@/components/ui/TextLink";
import { buildHead } from "@/presentation/head";

export const Route = createFileRoute("/password-reset")({
  head: ({ match }) => {
    const config = match.context.config;
    if (!config) return {};
    return {
      meta: buildHead(config, {
        title: "パスワードリセット",
        path: "/password-reset",
      }).meta,
    };
  },
  component: PasswordResetPage,
});

// Placeholder for the password-reset slice (ADR-007). The link from
// /login has to actually go somewhere, and a page that states its own
// status honours that better than a dead control.
function PasswordResetPage() {
  return (
    <AuthSheet title="パスワードリセット" description="この機能は準備中です">
      <div className="text-center text-sm">
        <TextLink to="/login">ログインに戻る</TextLink>
      </div>
    </AuthSheet>
  );
}
