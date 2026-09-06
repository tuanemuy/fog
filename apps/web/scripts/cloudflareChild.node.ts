import { spawn } from "node:child_process";

export type ChildCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  output?: { mode: "diagnostic" } | { mode: "discard"; failureLabel: string };
};

export function runChildCommand(input: ChildCommand): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const output = input.output ?? { mode: "diagnostic" };
    if (input.signal?.aborted) {
      reject(
        output.mode === "discard"
          ? new Error(`${output.failureLabel} aborted before start`)
          : (input.signal.reason ?? new Error("Operation aborted")),
      );
      return;
    }
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: [
        input.stdin === undefined ? "ignore" : "pipe",
        output.mode === "discard" ? "ignore" : "pipe",
        output.mode === "discard" ? "ignore" : "pipe",
      ],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (output.mode === "diagnostic") {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    }
    let terminalError: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      terminalError =
        output.mode === "discard"
          ? true
          : (input.signal?.reason ?? new Error("Operation aborted"));
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      terminalError = output.mode === "discard" ? true : error;
    });
    child.stdin?.on("error", (error) => {
      terminalError = output.mode === "discard" ? true : error;
      child.kill("SIGTERM");
    });
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", abort);
      if (output.mode === "diagnostic") {
        const diagnosticStdout = Buffer.concat(stdout).toString("utf8");
        const diagnosticStderr = Buffer.concat(stderr).toString("utf8");
        if (diagnosticStdout) process.stdout.write(diagnosticStdout);
        if (diagnosticStderr) process.stderr.write(diagnosticStderr);
      }
      if (terminalError) {
        reject(
          output.mode === "discard"
            ? new Error(
                `${output.failureLabel} failed with ${code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`}`,
              )
            : terminalError,
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${output.mode === "discard" ? output.failureLabel : "Child process"} failed with ${code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`}`,
        ),
      );
    });
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
  });
}

export async function withProcessSignals<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) =>
    controller.abort(new Error(`Interrupted by ${signal}`));
  const onInterrupt = () => abort("SIGINT");
  const onTerminate = () => abort("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    return await operation(controller.signal);
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

export function cloudflareChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (source[key] !== undefined) env[key] = source[key];
  return env;
}
