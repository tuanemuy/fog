import { UserId } from "@repo/core/domain/identity/valueObject";
import type { ServiceArgs } from "../types";

export type LogoutInput = {
  userId: string;
};

/**
 * Logs out.
 *
 * Nothing to do in the domain — the usecase exists so the application
 * layer offers the same surface for logout as for login rather than
 * leaving one half of the pair to be discovered in a route handler.
 *
 * It touches no repository and collects no event, so `UserId.create` is
 * the only work: a caller passing an empty id has a broken session and
 * should hear about it here.
 */
export async function logout({
  input,
}: ServiceArgs<LogoutInput>): Promise<void> {
  UserId.create(input.userId);
}
