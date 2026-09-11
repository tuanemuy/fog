import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { AuthSheetRouteError } from "@/components/layout/AuthSheet";
import { requireSessionBeforeLoad } from "@/presentation/authGuard";

/**
 * The signed-in screens with the app shell's navigation. Its `beforeLoad`
 * is the shared session check, which also marks every document under it
 * `Cache-Control: no-store` (`requireSessionBeforeLoad`).
 *
 * A screen's failure is drawn in the sheet by the router's default; a
 * failure of this layout itself — the session check, the shell — is drawn
 * on the auth sheet (ADR-009 of Issue #22).
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: requireSessionBeforeLoad,
  component: AppLayout,
  errorComponent: AuthSheetRouteError,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
