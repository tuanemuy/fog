import type { TrashGateway } from "../../trash/gateway";

const TRASH_GATEWAY_METHODS = [
  "listTrash",
  "restoreMemo",
  "restoreDocument",
  "restoreTopic",
  "hardDeleteTrashItem",
  "emptyTrash",
] as const satisfies readonly (keyof TrashGateway)[];

type Exhaustive<T extends readonly (keyof TrashGateway)[]> =
  Exclude<keyof TrashGateway, T[number]> extends never ? T : never;
const _trashGatewayRoster: Exhaustive<typeof TRASH_GATEWAY_METHODS> =
  TRASH_GATEWAY_METHODS;
void _trashGatewayRoster;

/** Total `TrashGateway` whose every entry throws through `trip` unless overridden. */
export function trippingTrashGateway(
  trip: (name: keyof TrashGateway) => never,
  overrides: Partial<TrashGateway> = {},
): TrashGateway {
  const gateway = {} as Record<keyof TrashGateway, unknown>;
  for (const name of TRASH_GATEWAY_METHODS) {
    gateway[name] = overrides[name] ?? (() => trip(name));
  }
  return gateway as unknown as TrashGateway;
}
