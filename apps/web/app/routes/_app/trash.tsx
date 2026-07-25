import { createFileRoute } from "@tanstack/react-router";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { buildHead } from "@/presentation/head";

export const Route = createFileRoute("/_app/trash")({
  head: ({ match }) => {
    const config = match.context.config;
    if (!config) return {};
    return {
      meta: buildHead(config, { title: navTitle("/trash"), path: "/trash" })
        .meta,
    };
  },
  component: TrashPage,
});

// Placeholder so the global nav really navigates (ADR-007).
function TrashPage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">準備中です</p>
  );
}
