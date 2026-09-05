import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
const requireCore=createRequire(resolve('packages/core/package.json'));
export default defineConfig({resolve:{tsconfigPaths:true,alias:[{find:'@libsql/client',replacement:requireCore.resolve('@libsql/client')},{find:/^@repo\/core\/(.*)$/,replacement:resolve('packages/core/src/$1.ts')}]},test:{environment:'node',include:['.goal-implement/reviews/P4b-core-independent.test.ts'],testTimeout:15000}});
