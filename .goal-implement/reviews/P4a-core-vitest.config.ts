import { defineConfig } from 'vitest/config';
export default defineConfig({resolve:{alias:{'@libsql/client':new URL('../../packages/core/node_modules/@libsql/client',import.meta.url).pathname}},test:{environment:'node',testTimeout:20000,include:['.goal-implement/reviews/P4a-core-independent.test.ts']}});
