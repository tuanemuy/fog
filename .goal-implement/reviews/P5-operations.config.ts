import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
const require = createRequire(new URL("../../packages/core/package.json", import.meta.url));
export default defineConfig({ resolve: { alias: { "@libsql/client": require.resolve("@libsql/client") } }, test: { environment: "node", include: [".goal-implement/reviews/P5-operations-extra.test.ts"], testTimeout: 15000, maxWorkers: 1 } });
