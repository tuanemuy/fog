import { describe, expect, it } from "vitest";

const MARKER = "[#20-probe]"; // ログから grep するための目印
const SALT = new Uint8Array(16);
const SAMPLES = 3;
const BATCH = 5;
// it() の第3引数はタイムアウト（ミリ秒）。Vitest 4 の TestCollectorCallable は
// (name, fn?, options?: number) と (name, options?, fn?) の2つしか持たないので、
// オブジェクトをこの位置に置くと TS2345 で typecheck が落ちる。
const TIMEOUT_MS = 120_000;

// 全計測の結果をここに溜め、最後の REPORT テストが1つの Error に載せて投げる。
const results: Record<string, unknown> = {};

// workerd は Spectre 緩和で計算中に時計を進めない。タイムスタンプの
// 直前に I/O を1回挟んで時計を更新させ、さらに BATCH 件をまとめて
// 計ることで、1件あたりの分解能不足を吸収する。
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// importKey は計測に含めない（鍵をバッチ間で使い回している）。本番の
// derive() は呼び出しごとに importKey + deriveBits を払うので、ここで
// 出るのは 1 導出コストの下限であり、R-6 の増分見積もりには importKey
// 分が上乗せされる。t_A / t_B の比較には影響しない。
async function measure(hash: "SHA-256" | "SHA-512", iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("probe"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const params = { name: "PBKDF2", hash, salt: SALT, iterations } as const;
  await crypto.subtle.deriveBits(params, key, 256); // warm-up
  const samples: number[] = [];
  for (let s = 0; s < SAMPLES; s += 1) {
    await tick();
    const started = Date.now();
    for (let i = 0; i < BATCH; i += 1) {
      await crypto.subtle.deriveBits(params, key, 256);
    }
    await tick();
    samples.push((Date.now() - started) / BATCH);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(SAMPLES / 2)] ?? 0;
  results[`${hash}@${iterations}`] = {
    min: samples[0],
    median,
    max: samples[SAMPLES - 1],
    samples,
  };
  expect(median).toBeGreaterThan(0); // R-2: 全計測 0ms を自動で赤にする
  return median;
}

describe("#20 probe", () => {
  it(
    "G-0: derives PBKDF2+SHA-512 at 210k at all",
    async () => {
      try {
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("probe"),
          "PBKDF2",
          false,
          ["deriveBits"],
        );
        await crypto.subtle.deriveBits(
          {
            name: "PBKDF2",
            hash: "SHA-512",
            salt: SALT,
            iterations: 210_000,
          } as const,
          key,
          256,
        );
        results["G-0"] = { supported: true };
      } catch (e) {
        results["G-0"] = {
          supported: false,
          name: e instanceof Error ? e.name : typeof e,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
    TIMEOUT_MS,
  );

  it(
    "measures SHA-512 @ 210k",
    async () => {
      await measure("SHA-512", 210_000);
    },
    TIMEOUT_MS,
  );

  it(
    "measures SHA-256 @ 600k",
    async () => {
      await measure("SHA-256", 600_000);
    },
    TIMEOUT_MS,
  );

  it(
    "measures SHA-256 @ 210k (current, for continuity)",
    async () => {
      await measure("SHA-256", 210_000);
    },
    TIMEOUT_MS,
  );

  it("REPORT (intentionally fails to surface the numbers)", () => {
    throw new Error(`${MARKER} ${JSON.stringify(results)}`);
  });
});
