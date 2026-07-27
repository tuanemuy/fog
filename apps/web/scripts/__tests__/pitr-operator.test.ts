import type { PitrReceipt } from "@repo/core/adapters/cloudflare/pitrOperator";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseReceipt, restore, undo } from "../pitr-operator";

function receipt(restoreBookmark: string, undoBookmark: string): PitrReceipt {
  return {
    version: 2,
    target: {
      kind: "user-data",
      accountId: "disposable-account",
      objectName: "canonical-user-data",
    },
    restoreBookmark,
    undoBookmark,
    proof: {
      id: `proof-${restoreBookmark}`,
      previousSessionId: `session-${restoreBookmark}`,
      undoBookmark,
    },
    authority: { status: "active", epoch: 1 },
  };
}

describe("PITR operator CLI receipt contract", () => {
  it("passes restore stdout to undo without extracting a nested field", async () => {
    const calls: unknown[] = [];
    const restoreReceipt = receipt("old-bookmark", "pre-restore-bookmark");
    const undoReceipt = receipt(
      "pre-restore-bookmark",
      "post-restore-bookmark",
    );
    const operatorCall = async (body: unknown): Promise<unknown> => {
      calls.push(body);
      const action = (body as { action: string }).action;
      if (action === "schedule") return restoreReceipt;
      if (action === "undo") return undoReceipt;
      if (action === "verify") return { currentBookmark: "verified" };
      return { phase: "restart-requested" };
    };

    const restored = await restore(
      { kind: "user-data", accountId: "disposable-account" },
      "old-bookmark",
      operatorCall,
    );
    const stdout = JSON.stringify(restored);
    const undone = await undo(parseReceipt(stdout), operatorCall);

    expect(restored).toEqual(restoreReceipt);
    expect(undone).toEqual(undoReceipt);
    expect(calls.map((item) => (item as { action: string }).action)).toEqual([
      "schedule",
      "restart",
      "verify",
      "undo",
      "restart",
      "verify",
    ]);
  });

  it("passes restore stdout to the undo CLI through a fake operator server", async () => {
    const calls: Array<{ action: string }> = [];
    const restoreReceipt = receipt("old-bookmark", "pre-restore-bookmark");
    const undoReceipt = receipt(
      "pre-restore-bookmark",
      "post-restore-bookmark",
    );
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          action: string;
        };
        calls.push(body);
        const result =
          body.action === "schedule"
            ? restoreReceipt
            : body.action === "undo"
              ? undoReceipt
              : body.action === "verify"
                ? { currentBookmark: "verified" }
                : { phase: "restart-requested" };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake operator did not bind a TCP port");
    }
    const run = (args: readonly string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          "pnpm",
          ["--filter", "@repo/web", "pitr:operator", ...args],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PITR_OPERATOR_URL: `http://127.0.0.1:${address.port}`,
              PITR_OPERATOR_TOKEN: "test-operator-token",
            },
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`CLI exited ${String(code)}: ${stderr}`));
        });
      });

    try {
      const stdout = await run([
        "restore",
        "user-data",
        "disposable-account",
        "old-bookmark",
      ]);
      expect(JSON.parse(stdout)).toEqual(restoreReceipt);
      expect(JSON.parse(await run(["undo", stdout]))).toEqual(undoReceipt);
      expect(calls.map(({ action }) => action)).toEqual([
        "schedule",
        "restart",
        "verify",
        "undo",
        "restart",
        "verify",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
