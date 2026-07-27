#!/usr/bin/env tsx
import type {
  PitrReceipt,
  PitrTarget,
} from "@repo/core/adapters/cloudflare/pitrOperator";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function target(
  kind: string | undefined,
  name: string | undefined,
): PitrTarget {
  const value = required(name, "account-or-shard");
  if (kind === "user-data") return { kind, accountId: value };
  if (kind === "identity-directory") return { kind, shard: value };
  throw new Error("target kind must be user-data or identity-directory");
}

function receipt(value: string | undefined): PitrReceipt {
  const parsed: unknown = JSON.parse(required(value, "receipt-json"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1
  ) {
    throw new Error("receipt-json must be a version 1 PITR receipt");
  }
  return parsed as PitrReceipt;
}

async function call(body: unknown): Promise<unknown> {
  const baseUrl = required(process.env.PITR_OPERATOR_URL, "PITR_OPERATOR_URL");
  const token = required(
    process.env.PITR_OPERATOR_TOKEN,
    "PITR_OPERATOR_TOKEN",
  );
  const response = await fetch(new URL("/_operator/pitr", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `PITR operator failed (${response.status}): ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function restore(
  pitrTarget: PitrTarget,
  bookmark: string,
): Promise<unknown> {
  const scheduled = (await call({
    action: "schedule",
    target: pitrTarget,
    bookmark,
  })) as PitrReceipt;
  await call({ action: "restart", receipt: scheduled });
  return verifyUntilComplete(scheduled);
}

async function undo(pitrReceipt: PitrReceipt): Promise<unknown> {
  const scheduled = (await call({
    action: "undo",
    receipt: pitrReceipt,
  })) as PitrReceipt;
  await call({ action: "restart", receipt: scheduled });
  return verifyUntilComplete(scheduled);
}

async function verifyUntilComplete(initial: PitrReceipt): Promise<unknown> {
  let current = initial;
  for (let page = 0; page < 10_000; page += 1) {
    const verification = (await call({
      action: "verify",
      receipt: current,
    })) as {
      receipt?: PitrReceipt;
      reconciliation?: { complete: boolean };
    };
    if (verification.receipt !== undefined) current = verification.receipt;
    if (
      verification.reconciliation === undefined ||
      verification.reconciliation.complete
    ) {
      return { receipt: current, verification };
    }
  }
  throw new Error("Directory reconciliation exceeded 10000 pages");
}

async function main(): Promise<void> {
  const [action, kindOrReceipt, name, bookmark] = process.argv.slice(2);
  let result: unknown;
  if (action === "bookmark") {
    result = await call({
      action,
      target: target(kindOrReceipt, name),
    });
  } else if (action === "restore") {
    result = await restore(
      target(kindOrReceipt, name),
      required(bookmark, "bookmark"),
    );
  } else if (action === "undo") {
    result = await undo(receipt(kindOrReceipt));
  } else if (action === "verify") {
    result = await call({ action, receipt: receipt(kindOrReceipt) });
  } else {
    throw new Error(
      "usage: pitr-operator.ts bookmark <user-data|identity-directory> <account-or-shard> | restore <kind> <account-or-shard> <bookmark> | undo|verify '<receipt-json>'",
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
