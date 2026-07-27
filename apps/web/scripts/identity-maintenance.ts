#!/usr/bin/env tsx
export {};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [action, generation, bucketValue, limitValue] = process.argv.slice(2);
  if (
    action !== "rotate-page" &&
    action !== "reconcile-page" &&
    action !== "status"
  ) {
    throw new Error(
      "usage: identity-maintenance.ts <rotate-page|reconcile-page|status> <generation> <bucket> [limit]",
    );
  }
  const bucket = Number(required(bucketValue, "bucket"));
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  const baseUrl = required(process.env.PITR_OPERATOR_URL, "PITR_OPERATOR_URL");
  const token = required(
    process.env.PITR_OPERATOR_TOKEN,
    "PITR_OPERATOR_TOKEN",
  );
  const response = await fetch(
    new URL("/_operator/identity-maintenance", baseUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action,
        generation: required(generation, "generation"),
        bucket,
        ...(limit === undefined ? {} : { limit }),
      }),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `Identity maintenance failed (${response.status}): ${JSON.stringify(result)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
