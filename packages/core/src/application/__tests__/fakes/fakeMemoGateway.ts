import type { MemoGateway } from "../../memo/gateway";

const MEMO_GATEWAY_METHODS = [
  "postMemo",
  "getTimeline",
  "jumpToDate",
  "showMemoInTimeline",
  "editMemo",
  "listMemoRevisions",
  "diffMemoRevisions",
  "rollbackMemo",
  "softDeleteMemo",
] as const satisfies readonly (keyof MemoGateway)[];

type Exhaustive<T extends readonly (keyof MemoGateway)[]> =
  Exclude<keyof MemoGateway, T[number]> extends never ? T : never;
const _memoGatewayRoster: Exhaustive<typeof MEMO_GATEWAY_METHODS> =
  MEMO_GATEWAY_METHODS;
void _memoGatewayRoster;

/** Total `MemoGateway` whose every entry throws through `trip` unless overridden. */
export function trippingMemoGateway(
  trip: (name: keyof MemoGateway) => never,
  overrides: Partial<MemoGateway> = {},
): MemoGateway {
  const gateway = {} as Record<keyof MemoGateway, unknown>;
  for (const name of MEMO_GATEWAY_METHODS) {
    gateway[name] = overrides[name] ?? (() => trip(name));
  }
  return gateway as unknown as MemoGateway;
}
