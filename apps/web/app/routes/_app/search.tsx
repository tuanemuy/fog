import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { Suspense } from "react";
import { SearchSkeleton } from "@/components/search/SearchSkeleton";
import { searchPageSchema } from "@/components/search/search";
import { Deferred } from "@/components/ui/Deferred";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { routeHead } from "@/presentation/head";
import { streamingRouteOptions } from "@/presentation/streamingRoute";
import { validateInput } from "@/presentation/validator";

const renderSearch = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(searchPageSchema))
  .handler(async ({ data }) => {
    const { SearchFeed } = await import("@/components/search/SearchFeed");
    return { Search: renderServerComponent(<SearchFeed search={data} />) };
  });

/** P-11. */
export const Route = createFileRoute("/_app/search")({
  staticData: { header: { kind: "top", title: "検索" } },
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  ...streamingRouteOptions,
  validateSearch: (search) => searchPageSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const { Search } = await renderSearch({ data: deps });
    return { Search };
  },
  head: ({ match }) =>
    routeHead(match, { title: "検索 — fog", path: "/search" }),
  component: SearchPage,
});

function SearchPage() {
  const { Search } = Route.useLoaderData();
  const { q, topic } = Route.useSearch();
  return (
    <div className="pb-sheet-end">
      {/* Keyed per query so a new search always shows the loading state. */}
      <Suspense
        key={`${q ?? ""}|${topic ?? ""}`}
        fallback={<SearchSkeleton q={q} />}
      >
        <Deferred promise={Search} />
      </Suspense>
    </div>
  );
}
