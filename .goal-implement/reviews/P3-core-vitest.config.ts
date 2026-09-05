import { defineConfig } from "vitest/config";
export default defineConfig({resolve:{alias:{"@libsql/client":"/Users/hikaru/github.com/tuanemuy/fog/node_modules/.pnpm/@libsql+client@0.17.3/node_modules/@libsql/client"}},test:{environment:"node",include:[".goal-implement/reviews/P3-core-independent.test.ts"]}});
