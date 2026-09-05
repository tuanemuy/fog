import type { FogServices } from "./types";

const runtimeKey = Symbol.for("fog.services");
type RuntimeGlobal = typeof globalThis & { [runtimeKey]?: FogServices };

export function installFogServices(services: FogServices): void {
  (globalThis as RuntimeGlobal)[runtimeKey] = services;
}

export function getFogServices(): FogServices {
  const services = (globalThis as RuntimeGlobal)[runtimeKey];
  if (!services) throw new Error("fog runtime is not initialized");
  return services;
}
