import { SHEET_SECTION_CLASS } from "@/components/ui/SheetSection";

/**
 * One block of the done page under the description (`.section-head` in
 * `spec/design/pages/password-reset.html`, 完了): a section's space above it
 * and the hairline that separates it from what came before. Shared by the
 * feed and its skeleton so the swap does not move the blocks.
 */
export const DONE_SECTION_CLASS = SHEET_SECTION_CLASS;

/** The way on to the app under the blocks, stretched to the sheet's width. */
export const DONE_ACTIONS_CLASS = "mt-section flex flex-col";
