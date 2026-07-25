import { createFileRoute } from "@tanstack/react-router";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { routeHead } from "@/presentation/head";

export const Route = createFileRoute("/_app/trash")({
  head: ({ match }) =>
    routeHead(match, { title: navTitle("/trash"), path: "/trash" }),
  component: TrashPage,
});

// Placeholder so the global nav really navigates (.issue/1/adr.md ADR-007).
function TrashPage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">準備中です</p>
  );
}
