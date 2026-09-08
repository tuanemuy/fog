import type { ExportGateway } from "../../export/gateway";

const EXPORT_GATEWAY_METHODS = [
  "readExportSource",
] as const satisfies readonly (keyof ExportGateway)[];

type Exhaustive<T extends readonly (keyof ExportGateway)[]> =
  Exclude<keyof ExportGateway, T[number]> extends never ? T : never;
const _exportGatewayRoster: Exhaustive<typeof EXPORT_GATEWAY_METHODS> =
  EXPORT_GATEWAY_METHODS;
void _exportGatewayRoster;

/** Total `ExportGateway` whose every entry throws through `trip` unless overridden. */
export function trippingExportGateway(
  trip: (name: keyof ExportGateway) => never,
  overrides: Partial<ExportGateway> = {},
): ExportGateway {
  const gateway = {} as Record<keyof ExportGateway, unknown>;
  for (const name of EXPORT_GATEWAY_METHODS) {
    gateway[name] = overrides[name] ?? (() => trip(name));
  }
  return gateway as unknown as ExportGateway;
}
