import { createFileRoute } from "@tanstack/react-router";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { buildHead } from "@/presentation/head";

export const Route = createFileRoute("/_app/topics")({
  head: ({ match }) => {
    const config = match.context.config;
    if (!config) return {};
    return {
      meta: buildHead(config, { title: navTitle("/topics"), path: "/topics" })
        .meta,
    };
  },
  component: TopicsPage,
});

// Placeholder so the global nav really navigates (ADR-007).
function TopicsPage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">準備中です</p>
  );
}
