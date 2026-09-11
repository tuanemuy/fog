import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { requireSessionBeforeLoad } from "@/presentation/authGuard";

/**
 * The signed-in screens with the app shell's navigation. Its `beforeLoad`
 * is the shared session check, which also marks every document under it
 * `Cache-Control: no-store` (`requireSessionBeforeLoad`).
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: requireSessionBeforeLoad,
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
