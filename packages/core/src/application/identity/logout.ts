import { UserId } from "@repo/core/domain/identity/valueObject";
import type { ServiceArgs } from "../types";

export type LogoutInput = Readonly<{ userId: string }>;

/**
 * S-AC-04. The identity domain has no logout transition; the session itself
 * is destroyed by the presentation layer after this returns. Kept so the
 * application layer's public face lists every scenario.
 */
export async function logout({
  input,
}: ServiceArgs<LogoutInput>): Promise<void> {
  UserId.create(input.userId);
}
