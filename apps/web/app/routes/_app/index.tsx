import { createFileRoute } from "@tanstack/react-router";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { routeHead } from "@/presentation/head";

export const Route = createFileRoute("/_app/")({
  head: ({ match }) => routeHead(match, { title: navTitle("/"), path: "/" }),
  component: TimelinePage,
});

// Placeholder: memo listing is not implemented yet, so the page is just the
// empty state.
function TimelinePage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">
      まだメモがありません
    </p>
  );
}
