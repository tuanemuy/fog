import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/topics")({
  component: TopicsPage,
});

// Placeholder so the global nav really navigates (ADR-007).
function TopicsPage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">準備中です</p>
  );
}
