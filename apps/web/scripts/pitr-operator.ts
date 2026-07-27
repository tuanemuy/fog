#!/usr/bin/env tsx
export {};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [action, className, objectName, accountId, bookmark] =
    process.argv.slice(2);
  if (action !== "bookmark" && action !== "restore") {
    throw new Error(
      "usage: pitr-operator.ts <bookmark|restore> <class> <object-name> <account-id> [bookmark]",
    );
  }
  if (action === "restore" && bookmark === undefined) {
    throw new Error("restore requires a bookmark");
  }
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
    body: JSON.stringify({
      action,
      className: required(className, "class"),
      objectName: required(objectName, "object-name"),
      accountId: required(accountId, "account-id"),
      ...(bookmark === undefined ? {} : { bookmark }),
    }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `PITR operator failed (${response.status}): ${JSON.stringify(result)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
