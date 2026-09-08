import type { SearchGateway } from "../../search/gateway";

const SEARCH_GATEWAY_METHODS = [
  "search",
] as const satisfies readonly (keyof SearchGateway)[];

type Exhaustive<T extends readonly (keyof SearchGateway)[]> =
  Exclude<keyof SearchGateway, T[number]> extends never ? T : never;
const _searchGatewayRoster: Exhaustive<typeof SEARCH_GATEWAY_METHODS> =
  SEARCH_GATEWAY_METHODS;
void _searchGatewayRoster;

/** Total `SearchGateway` whose every entry throws through `trip` unless overridden. */
export function trippingSearchGateway(
  trip: (name: keyof SearchGateway) => never,
  overrides: Partial<SearchGateway> = {},
): SearchGateway {
  const gateway = {} as Record<keyof SearchGateway, unknown>;
  for (const name of SEARCH_GATEWAY_METHODS) {
    gateway[name] = overrides[name] ?? (() => trip(name));
  }
  return gateway as unknown as SearchGateway;
}
