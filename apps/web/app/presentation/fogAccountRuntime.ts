type Runtime = { googleEnabled: boolean; createBrowserToken: () => string };
const key = Symbol.for("fog.account-runtime");
type Global = typeof globalThis & { [key]?: Runtime };
export function installFogAccountRuntime(runtime: Runtime) {
  (globalThis as Global)[key] = runtime;
}
export function getFogAccountRuntime() {
  const value = (globalThis as Global)[key];
  if (!value) throw new Error("Account runtime is not installed");
  return value;
}
