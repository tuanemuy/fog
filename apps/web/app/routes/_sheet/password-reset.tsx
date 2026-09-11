import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PasswordResetForm } from "@/components/auth/PasswordResetForm";
import { PasswordResetRequestForm } from "@/components/auth/PasswordResetRequestForm";
import { routeHead } from "@/presentation/head";

const searchSchema = z.object({
  token: z.string().min(1).max(512).optional(),
});

/**
 * P-03, reachable without a session. With `?token=` the page sets the new
 * password; without it, it asks for the address. The referrer policy is
 * `no-referrer` so the token in the URL never leaks through an outbound
 * link or an image.
 */
export const Route = createFileRoute("/_sheet/password-reset")({
  validateSearch: searchSchema,
  head: ({ match }) => {
    const head = routeHead(match, {
      title: "パスワードリセット — fog",
      path: "/password-reset",
    });
    return {
      ...head,
      meta: [
        ...(head.meta ?? []),
        { name: "referrer", content: "no-referrer" },
      ],
    };
  },
  component: PasswordResetPage,
});

function PasswordResetPage() {
  const { token } = Route.useSearch();
  if (token !== undefined) return <PasswordResetForm token={token} />;
  return <PasswordResetRequestForm />;
}
