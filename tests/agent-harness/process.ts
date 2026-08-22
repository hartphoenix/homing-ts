import { spawn } from "node:child_process";

export type ChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ChildOptions = {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  input?: string;
};

function appendBounded(current: Buffer[], size: number, chunk: Buffer, limit: number): number {
  if (size >= limit) return size;
  const kept = chunk.subarray(0, Math.max(0, limit - size));
  current.push(kept);
  return size + kept.byteLength;
}

export async function runChild(argv: string[], options: ChildOptions): Promise<ChildResult> {
  if (!argv[0]) throw new Error("Child argv is empty");
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024;
  const child = spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutSize = appendBounded(stdout, stdoutSize, chunk, maxOutput);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrSize = appendBounded(stderr, stderrSize, chunk, maxOutput);
  });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();

  let timedOut = false;
  let escalation: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
    escalation = new Promise((resolve) => {
      setTimeout(() => {
        if (process.platform !== "win32" && child.pid) {
          try {
            // Kill the group even when its leader exited after TERM. A surviving
            // descendant must not outlive the harness result.
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // ESRCH means the complete group is already gone.
          }
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, options.killGraceMs ?? 1000);
    });
  }, options.timeoutMs ?? 15_000);

  const result = await new Promise<Pick<ChildResult, "exitCode" | "signal">>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timer);
  if (escalation) await escalation;
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    timedOut,
  };
}
