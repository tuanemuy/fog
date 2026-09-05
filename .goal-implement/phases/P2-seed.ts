import { createLibsqlClient } from "../../packages/core/src/adapters/libsql/client";
import { nodeSecretCrypto } from "../../packages/core/src/adapters/fog/crypto";
import { migrateFog } from "../../packages/core/src/adapters/fog/schema";
import { LibsqlFogUnitOfWork } from "../../packages/core/src/adapters/fog/unitOfWork";
import { createFogServices } from "../../packages/core/src/application/fog/services";
import { UuidV7Generator } from "../../packages/core/src/application/ports/idGenerator";

const client = createLibsqlClient({ url: "file:../../apps/web/data/app.db" });
await client.execute("PRAGMA journal_mode=WAL");
await client.execute("PRAGMA foreign_keys=ON");
await client.execute("PRAGMA busy_timeout=5000");
await migrateFog(client);
const user = (await client.execute("SELECT id FROM fog_users WHERE email='p1-a@example.test'")).rows[0];
if (!user || typeof user.id !== "string") throw new Error("Register the P1 test account first");
const actor = { kind: "human" as const, userId: user.id, email: "p1-a@example.test" };
let now = new Date("2026-08-01T10:00:00.000Z");
const services = await createFogServices({ unitOfWork: new LibsqlFogUnitOfWork(client), crypto: nodeSecretCrypto, clock: { now: () => now }, ids: UuidV7Generator });
if (!(await services.listMemos(actor)).some((memo) => memo.body.startsWith("P2 過去メモ"))) {
  for (let index = 0; index < 65; index++) {
    now = new Date(Date.UTC(2026, 7, 1 + Math.floor(index / 10), 10, index % 10));
    await services.createMemo(actor, { body: `P2 過去メモ ${String(index + 1).padStart(2, "0")}\nページングの重複と欠落を確認する。` });
  }
}
console.log(JSON.stringify((await services.listMemos(actor)).filter((memo) => memo.body.startsWith("P2 過去メモ")).map(({ id, createdAt, body }) => ({ id, createdAt, body })), null, 2));
client.close();
