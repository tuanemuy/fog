import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/trash")({
  component: TrashPage,
});

// Placeholder so the global nav really navigates (ADR-007).
function TrashPage() {
  return (
    <p className="py-2xl text-center text-base text-neutral-600">準備中です</p>
  );
}
