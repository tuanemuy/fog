import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Client, InValue, ResultSet, Transaction } from "@libsql/client";
import { migrateFog } from "@repo/core/adapters/fog/schema";
import { createLibsqlClient } from "@repo/core/adapters/libsql/client";
import { withProcessSignals } from "./cloudflareChild.node";
import { stageConfigPath } from "./cloudflareConfig.node";
import {
  type CloudflarePreflight,
  loadCloudflarePreflight,
} from "./cloudflarePreflight.node";
import { deploymentStage } from "./cloudflareStage";

type MigrationClient = Pick<
  Client,
  "execute" | "batch" | "close" | "transaction"
>;
type MigrationTransaction = Pick<
  Transaction,
  "execute" | "batch" | "commit" | "rollback" | "close"
>;

const identityTable = `CREATE TABLE IF NOT EXISTS fog_deployment_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  stage TEXT NOT NULL CHECK(stage IN ('staging', 'production')),
  database_identity TEXT NOT NULL
)`;
async function execute(
  client: Pick<MigrationClient, "execute">,
  sql: string,
  args: InValue[] = [],
): Promise<ResultSet> {
  return client.execute({ sql, args });
}

async function verifyOrBootstrapIdentity(
  client: Pick<MigrationTransaction, "execute" | "batch">,
  preflight: CloudflarePreflight,
): Promise<void> {
  const table = await execute(
    client,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='fog_deployment_identity'",
  );
  if (table.rows.length === 0) {
    if (preflight.databaseIdentityRebindFrom)
      throw new Error(
        "Database identity marker is absent; PITR rebind requires the exact previous marker",
      );
    if (!preflight.bootstrapDatabaseIdentity)
      throw new Error(
        "Database identity marker is absent; set DATABASE_IDENTITY_BOOTSTRAP=true for the explicit first migration",
      );
    await client.batch([
      identityTable,
      {
        sql: "INSERT OR IGNORE INTO fog_deployment_identity(singleton,stage,database_identity) VALUES(1,?,?)",
        args: [
          preflight.stage,
          preflight.config.vars.EXPECTED_DATABASE_IDENTITY,
        ],
      },
    ]);
  }
  const marker = await execute(
    client,
    "SELECT stage,database_identity FROM fog_deployment_identity WHERE singleton=1",
  );
  if (marker.rows.length !== 1 || marker.rows[0]?.stage !== preflight.stage)
    throw new Error(
      "Database identity marker does not match the selected stage",
    );
  const databaseIdentity = marker.rows[0]?.database_identity;
  const expectedIdentity = preflight.config.vars.EXPECTED_DATABASE_IDENTITY;
  if (databaseIdentity === expectedIdentity) return;
  if (
    preflight.databaseIdentityRebindFrom &&
    databaseIdentity === preflight.databaseIdentityRebindFrom
  ) {
    const updated = await execute(
      client,
      "UPDATE fog_deployment_identity SET database_identity=? WHERE singleton=1 AND stage=? AND database_identity=?",
      [expectedIdentity, preflight.stage, preflight.databaseIdentityRebindFrom],
    );
    if (updated.rowsAffected !== 1)
      throw new Error("Database identity marker changed during PITR rebind");
    return;
  }
  throw new Error("Database identity marker does not match the selected stage");
}

export async function runCloudflareMigration(input: {
  preflight: CloudflarePreflight;
  createClient?: (config: {
    url: string;
    authToken: string;
  }) => MigrationClient;
  migrate?: (
    client: Pick<MigrationTransaction, "execute" | "batch">,
  ) => Promise<void>;
}): Promise<void> {
  const client = (input.createClient ?? createLibsqlClient)({
    url: input.preflight.runtimeSecrets.DATABASE_URL,
    authToken: input.preflight.runtimeSecrets.DATABASE_AUTH_TOKEN,
  });
  let transaction: MigrationTransaction | undefined;
  let committed = false;
  try {
    await execute(client, "SELECT 1");
    transaction = await client.transaction("write");
    await verifyOrBootstrapIdentity(transaction, input.preflight);
    await (
      input.migrate ??
      (migrateFog as (
        client: Pick<MigrationTransaction, "execute" | "batch">,
      ) => Promise<void>)
    )(transaction);
    await transaction.commit();
    committed = true;
  } finally {
    try {
      if (transaction) {
        try {
          if (!committed) await transaction.rollback();
        } finally {
          transaction.close();
        }
      }
    } finally {
      client.close();
    }
  }
}

function option(name: string): string | undefined {
  const position = process.argv.indexOf(name);
  return position < 0 ? undefined : process.argv[position + 1];
}

async function main(): Promise<void> {
  const stage = deploymentStage(option("--stage"));
  const requested = option("--config");
  if (!requested) throw new Error("--config is required for remote migration");
  if (path.resolve(requested) !== stageConfigPath(stage))
    throw new Error(`--config must be the generated ${stage} config`);
  await withProcessSignals(async (signal) => {
    const preflight = await loadCloudflarePreflight({
      stage,
      source: process.env,
      sideEffect: true,
    });
    if (signal.aborted) throw signal.reason;
    await runCloudflareMigration({ preflight });
  });
  console.log(`[fog.migrate.cloudflare] schema ready for ${stage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.migrate.cloudflare] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
