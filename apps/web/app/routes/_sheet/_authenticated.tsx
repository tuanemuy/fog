import { createFileRoute } from "@tanstack/react-router";
import { requireSessionBeforeLoad } from "@/presentation/authGuard";

/**
 * The auth-sheet screens a session reaches: AI client authorization and the
 * reset's done page (ADR-008 of Issue #22). The same session check as
 * `_app`, so an unauthenticated visitor goes through `/login` and back, and
 * both documents stay `Cache-Control: no-store`.
 */
export const Route = createFileRoute("/_sheet/_authenticated")({
  beforeLoad: requireSessionBeforeLoad,
});
