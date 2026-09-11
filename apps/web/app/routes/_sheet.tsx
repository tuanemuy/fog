import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AuthSheet } from "@/components/layout/AuthSheet";

/**
 * The screens drawn on the auth sheet, without the app's navigation
 * (ADR-008 of Issue #22): login, signup and the password reset here, and
 * under `_authenticated` the two a session reaches. The layout decides the
 * frame; each screen draws only its content.
 */
export const Route = createFileRoute("/_sheet")({
  component: SheetLayout,
});

function SheetLayout() {
  return (
    <AuthSheet>
      <Outlet />
    </AuthSheet>
  );
}
