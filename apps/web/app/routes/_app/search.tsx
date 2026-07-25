import { createFileRoute } from "@tanstack/react-router";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { routeHead } from "@/presentation/head";

export const Route = createFileRoute("/_app/search")({
  head: ({ match }) =>
    routeHead(match, { title: navTitle("/search"), path: "/search" }),
  component: SearchPage,
});

// Placeholder so the global nav really navigates (ADR-007).
function SearchPage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">準備中です</p>
  );
}
