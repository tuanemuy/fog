import { createFileRoute } from "@tanstack/react-router";
import { navTitle } from "@/components/layout/AppShell/navItems";
import { routeHead } from "@/presentation/head";

export const Route = createFileRoute("/_app/")({
  head: ({ match }) => routeHead(match, { title: navTitle("/"), path: "/" }),
  component: TimelinePage,
});

// Memo listing arrives with the timeline slice; the shell and the empty
// state are all this slice owns.
function TimelinePage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">
      まだメモがありません
    </p>
  );
}
