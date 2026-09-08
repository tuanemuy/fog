import { HardDeletePolicy } from "@repo/core/domain/trash/service";
import type { UserDataUnitOfWorkContext } from "../execution/unitOfWork";
import type { ServiceArgs } from "../types";
import type { TrashItemRefDto } from "./gateway";
import { executeHardDeletePlan } from "./hardDeleteSteps";
import { rebuildRef, trashItemNotFound } from "./shared";

export type HardDeleteTrashItemInput = Readonly<{
  userId: string;
  kind: "memo" | "document" | "topic";
  id: string;
}>;

/** S-TR-03, request side. The 「元に戻せません」 confirmation is the screen's. */
export async function hardDeleteTrashItem({
  container,
  input,
}: ServiceArgs<HardDeleteTrashItemInput>): Promise<void> {
  await container.trashGateway.hardDeleteTrashItem(input.userId, {
    kind: input.kind,
    id: input.id,
  });
}

/** Inside the DO, one transaction: a topic takes its set with it. */
export function hardDeleteTrashItemProcedure(
  ctx: UserDataUnitOfWorkContext,
  dto: TrashItemRefDto,
): void {
  const item = ctx.trashQueryPort.findTrashItem(rebuildRef(dto));
  if (item === null) throw trashItemNotFound();
  executeHardDeletePlan(ctx, HardDeletePolicy.expandTargets(item));
}
