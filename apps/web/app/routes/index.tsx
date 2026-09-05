import { createFileRoute, redirect } from "@tanstack/react-router";
import { loadFogSession } from "@/presentation/fogActions";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const actor = await loadFogSession({ data: {} });
    if (actor) throw redirect({ to: "/timeline" });
    throw redirect({ to: "/login", search: { returnTo: "/timeline" } });
  },
});
