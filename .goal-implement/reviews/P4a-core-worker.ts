import { createRequire } from 'node:module';
import { createAiServices } from '../../packages/core/src/application/fog/aiServices';
import { nodeSecretCrypto } from '../../packages/core/src/adapters/fog/crypto';
import { LibsqlFogUnitOfWork } from '../../packages/core/src/adapters/fog/unitOfWork';
import { UuidV7Generator } from '../../packages/core/src/application/ports/idGenerator';
const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { createClient } = require('@libsql/client');
process.once('message', async (job: any) => {
  const client = createClient({url: job.url});
  await client.execute('PRAGMA journal_mode=WAL');
  await client.execute('PRAGMA foreign_keys=ON');
  await client.execute('PRAGMA busy_timeout=5000');
  const services = createAiServices({unitOfWork:new LibsqlFogUnitOfWork(client), crypto:nodeSecretCrypto, ids:UuidV7Generator, clock:{now:()=>new Date(job.now)}, aiClients:job.clients});
  process.once('message', async () => {
    try {
      const result = job.exchange ? await services.exchangeAiCode(job.exchange) : await services.executeAi(job.token, job.request);
      process.send?.({ok:true,result});
    } catch(error:any) { process.send?.({ok:false,code:error.code,message:error.message}); }
    finally {client.close();process.disconnect?.();}
  });
  process.send?.({ready:true});
});
