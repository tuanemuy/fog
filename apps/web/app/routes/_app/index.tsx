import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
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
