import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AuthorizeSheet } from "@/components/aiClients/AuthorizeSheet";
import { readAuthorizationRequestFn } from "@/components/aiClients/actions";
import type { AuthorizationRequestView } from "@/components/aiClients/schema";
import { routeHead } from "@/presentation/head";

const searchSchema = z.object({
  request: z.string().min(1).max(4096).optional(),
  error: z.enum(["invalid_request"]).optional(),
});

/**
 * P-14, behind the app's guard: an unauthenticated visitor goes through
 * P-01 and comes back with the same `request`. The referrer policy keeps
 * the request blob off any outbound link.
 */
export const Route = createFileRoute("/_app/ai-clients/authorize")({
  validateSearch: searchSchema,
  staleTime: 0,
  loaderDeps: ({ search }) => ({ request: search.request }),
  loader: async ({ deps }): Promise<{ view: AuthorizationRequestView }> => {
    if (deps.request === undefined) return { view: { ok: false } };
    const view = await readAuthorizationRequestFn({
      data: { request: deps.request },
    });
    return { view };
  },
  head: ({ match }) => {
    const head = routeHead(match, {
      title: "アクセス許可 — fog",
      path: "/ai-clients/authorize",
    });
    return {
      ...head,
      meta: [
        ...(head.meta ?? []),
        { name: "referrer", content: "no-referrer" },
      ],
    };
  },
  component: AuthorizePage,
});

function AuthorizePage() {
  const { request } = Route.useSearch();
  const { view } = Route.useLoaderData();
  return <AuthorizeSheet request={request} view={view} />;
}
